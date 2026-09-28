import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import {
  clampZoom,
  enableBestFocus,
  getZoom,
  probeCameraSupport,
  setTorch,
  setZoom as applyZoom,
  triggerFocusOnce,
  type CameraSupport,
} from '../lib/camera'
import { CAPTURE_IDEAL, planScanRegions } from '../lib/scan-plan'
import './QrScanner.css'

interface Props {
  onResult: (text: string) => void
  onCancel: () => void
}

/**
 * 解码节流间隔。
 *
 * 全分辨率 `getImageData` + jsQR 单次约 20~40ms，**每帧都跑**（60fps）会让主线程饱和 →
 * 掉帧、手机发热，**反而降低识别率**。10fps 对扫码足够，把省下的预算用于「多区域尝试」。
 *
 * 每次解码的**像素预算**（中心区不缩放但封顶、全帧兜底等比缩到 1280×720 以内）由
 * `lib/scan-plan.ts` 收口 —— 这里只管「多久扫一次」，不管「一次扫多少像素」。
 */
const DECODE_INTERVAL_MS = 100

/** 单次对焦（`single-shot`）设备的**重触发周期**：不重触发就会一直停在失焦状态。 */
const REFOCUS_INTERVAL_MS = 1500

/** 长时间识别不出 → 给出「物理层」建议（多数扫码失败与软件无关，见 `scanner__notice`）。 */
const SLOW_HINT_MS = 15000

/**
 * 摄像头扫码。
 *
 * ⚠️ **`getUserMedia` 只在安全上下文可用**：`https://` 或 `localhost`。
 * 手机通过 **HTTP + 局域网 IP** 访问时浏览器**不提供 `navigator.mediaDevices`**，
 * 直接调用会**同步抛错**（旧实现会让 React 卸载整棵树 = 全黑屏），故这里先做上下文检查，
 * 并把一切异常收敛为**可读文案**。
 *
 * ⚠️ **对焦控制的能力边界见 `lib/camera.ts` 文件头**：点按对焦在 Web 上做不到，
 * iOS 更是全部不支持 —— 不支持时这里显示说明，**不给无效按钮**。
 *
 * ⚠️ **「对不上焦」多数时候其实是像素不够**：手机离屏幕太近会低于镜头最近对焦距离（必糊，
 * 软件无解），而站远就要求码上有足够像素 —— 采集分辨率与解码像素预算见 `lib/scan-plan.ts`
 * 文件头（那里是「改常量前先读」的地方）。
 */
export default function QrScanner({ onResult, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const doneRef = useRef(false)
  const trackRef = useRef<MediaStreamTrack | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [support, setSupport] = useState<CameraSupport | null>(null)
  const [torchOn, setTorchOn] = useState(false)
  const [zoom, setZoomValue] = useState<number | null>(null)
  const [slow, setSlow] = useState(false)

  // 用 ref 持有回调：避免父级重渲染导致 effect 重启（重启会重新申请摄像头、白闪）
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let cancelled = false
    let lastDecode = 0
    let focusTimer: ReturnType<typeof setInterval> | null = null
    let slowTimer: ReturnType<typeof setTimeout> | null = null

    /**
     * 一次解码尝试：**先扫中心、再扫全帧**。
     *
     * 顺序理由：中心区域面积小 → 二值化与定位图案扫描都快，是绝大多数帧的最优路径；
     * 全帧兜底覆盖「码不在中心」的情况（不这样处理会漏掉靠边的码）。
     */
    const tryDecode = (): boolean => {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return false
      if (video.readyState !== video.HAVE_ENOUGH_DATA) return false
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return false

      // canvas 尺寸固定为视频原始分辨率，靠 drawImage 的源/目标矩形做「裁剪 + 缩放」——
      // 避免每帧改 canvas 尺寸（会重置画布状态，有成本）
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw
        canvas.height = vh
      }
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) return false

      // 区域与像素预算由 lib/scan-plan.ts 决定（中心优先 → 全帧兜底）
      for (const { sx, sy, sw, sh, dw, dh } of planScanRegions(vw, vh)) {
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh)
        const image = ctx.getImageData(0, 0, dw, dh)
        const code = jsQR(image.data, dw, dh, { inversionAttempts: 'dontInvert' })
        if (code && code.data) {
          doneRef.current = true
          onResultRef.current(code.data)
          return true
        }
      }
      return false
    }

    const tick = (now: number) => {
      if (cancelled || doneRef.current) return
      if (now - lastDecode >= DECODE_INTERVAL_MS) {
        lastDecode = now
        tryDecode()
      }
      if (!doneRef.current) raf = requestAnimationFrame(tick)
    }

    const start = async () => {
      // ① 安全上下文检查 —— 非 HTTPS 且非 localhost 时，浏览器不给 mediaDevices
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        setError(
          '当前页面不是安全上下文（HTTP）。手机浏览器要求 HTTPS（或 localhost）才允许使用摄像头。请改用下方「手动输入配对串」。',
        )
        return
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setError('当前浏览器不支持摄像头 API。请改用下方「手动输入配对串」。')
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            // ideal 而非 exact：不支持的机型会自行降级，不会直接失败。
            // 提高采集分辨率是有意义的 —— 默认可能只有 640×480，远处的码**像素本身就不够**，
            // 那种情况下「解不出」与对焦无关，是分辨率问题。
            // ⚠️ 720p → 1080p 是「能站多远」的关键：离屏幕太近会低于镜头最近对焦距离（必糊，
            //    软件无解），而拉远就要求码上有足够像素。理由与像素预算见 lib/scan-plan.ts。
            ...CAPTURE_IDEAL,
          },
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        if (cancelled) return

        // ② 摄像头调优：尽力打开自动对焦 / 探明变焦补光能力（不支持时全部降级，不抛错）
        const track = stream.getVideoTracks()[0] ?? null
        trackRef.current = track
        const caps = probeCameraSupport(track)
        setSupport(caps)
        const mode = await enableBestFocus(track, caps)
        if (cancelled) return
        if (mode === 'single-shot') {
          // 单次对焦只在对焦那一刻有效：周期性重触发，模拟「持续对焦」
          focusTimer = setInterval(() => {
            void triggerFocusOnce(track, caps)
          }, REFOCUS_INTERVAL_MS)
        }
        const z = getZoom(track)
        if (z !== null) setZoomValue(z)

        setReady(true)
        slowTimer = setTimeout(() => setSlow(true), SLOW_HINT_MS)
        raf = requestAnimationFrame(tick)
      } catch (err) {
        if (cancelled) return
        setError(describeCameraError(err))
      }
    }

    void start()

    return () => {
      cancelled = true
      if (raf) cancelAnimationFrame(raf)
      if (focusTimer) clearInterval(focusTimer)
      if (slowTimer) clearTimeout(slowTimer)
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  const zoomRange = support?.zoom ?? null
  const canControlFocus = support?.continuous === true || support?.singleShot === true
  const showsAnyTool = canControlFocus || support?.torch === true || zoomRange !== null

  const handleRefocus = () => {
    void triggerFocusOnce(trackRef.current, support ?? probeCameraSupport(null))
  }

  const handleTorch = async () => {
    const track = trackRef.current
    if (!track) return
    const next = !torchOn
    const ok = await setTorch(track, next)
    if (ok) setTorchOn(next)
  }

  const handleZoom = async (dir: -1 | 1) => {
    const track = trackRef.current
    if (!track || !zoomRange || zoom === null) return
    const next = clampZoom(zoom + dir * zoomRange.step, zoomRange)
    if (next === zoom) return
    setZoomValue(next) // 乐观更新（否则连点会被 await 卡住）
    const ok = await applyZoom(track, next)
    if (!ok) setZoomValue(zoom) // 失败回滚，避免 UI 与设备状态不一致
  }

  return (
    <div className="scanner">
      <div className="scanner__frame">
        <video ref={videoRef} className="scanner__video" playsInline muted />
        <canvas ref={canvasRef} className="scanner__canvas" />
        {ready && !error && <div className="scanner__reticle" />}
      </div>

      {ready && !error && showsAnyTool && (
        <div className="scanner__tools">
          {canControlFocus && (
            <button type="button" className="scanner__tool" onClick={handleRefocus}>
              重新对焦
            </button>
          )}
          {support?.torch === true && (
            <button
              type="button"
              className={`scanner__tool${torchOn ? ' is-on' : ''}`}
              onClick={() => void handleTorch()}
            >
              {torchOn ? '关闭补光' : '打开补光'}
            </button>
          )}
          {zoomRange !== null && zoom !== null && (
            <span className="scanner__zoom">
              <button
                type="button"
                className="scanner__tool"
                onClick={() => void handleZoom(-1)}
                aria-label="缩小"
              >
                −
              </button>
              <span className="scanner__zoom-value">{zoom.toFixed(1)}×</span>
              <button
                type="button"
                className="scanner__tool"
                onClick={() => void handleZoom(1)}
                aria-label="放大"
              >
                ＋
              </button>
            </span>
          )}
        </div>
      )}

      {error ? (
        <div className="scanner__banner">
          <strong>无法使用摄像头</strong>
          <span>{error}</span>
        </div>
      ) : (
        <div className="scanner__tips">
          <p className="scanner__hint">将电脑端二维码放入取景框</p>

          {ready && !showsAnyTool && (
            <p className="scanner__notice">
              本机浏览器不允许网页控制对焦（iOS 上普遍如此，由系统接管）——
              若画面持续模糊，请把手机**拿远一点**（多数手机最近对焦距离约 10~20 厘米，凑太近任何软件都对不上）。
            </p>
          )}

          {slow && (
            <p className="scanner__notice">
              还扫不到？① 先拉到 25~35 厘米 —— 凑太近会低于镜头最近对焦距离（那种糊任何软件都无解），
              而现在按 1080p 采集，拉远后码上仍够像素；② 稍微斜一点拍屏幕（正对易产生摩尔纹与反光）；
              ③ 或直接用下方「手动输入配对串」。
            </p>
          )}
        </div>
      )}

      <button type="button" className="btn btn--ghost" onClick={onCancel}>
        返回（改用手动输入）
      </button>
    </div>
  )
}

/** 把 getUserMedia 的异常翻译成人话（手机上没法看 console，文案必须自解释）。 */
function describeCameraError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '摄像头权限被拒绝。请在浏览器地址栏/设置里允许本站使用摄像头后重试，或改用手动输入。'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return '未找到可用摄像头（或后置摄像头不可用）。请改用手动输入。'
    case 'NotReadableError':
      return '摄像头被其它应用占用，或系统拒绝访问。请关闭占用程序后重试，或改用手动输入。'
    default:
      return err instanceof Error ? err.message : '无法访问摄像头，请改用手动输入。'
  }
}
