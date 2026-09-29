import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import {
  clampZoom,
  getZoom,
  probeCameraSupport,
  setTorch,
  setZoom as applyZoom,
  triggerFocusOnce,
  type CameraSupport,
} from '../lib/camera'
import { planScanRegions } from '../lib/scan-plan'
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
 * 软件无解），而站远又要求码上有足够像素 —— 解码的像素预算见 `lib/scan-plan.ts` 文件头
 * （那里是「改常量前先读」的地方）。
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
  /**
   * 取景框（reticle）的**像素边长**。
   *
   * 为什么用 JS 算而不是纯 CSS：视频用 `object-fit: contain` 铺进全屏后，
   * 实际显示框随**视频宽高比 × 屏幕宽高比**变化（横屏流在竖屏上有上下黑边）。
   * 用 `min(72vw,72vh)` 这类纯 CSS 尺寸会在竖屏手机上跑出画面、落到黑边上，
   * 所以按「视频真实显示框」的 70% 来定（`null` = 还没算出来，用 CSS 兜底）。
   */
  const [reticle, setReticle] = useState<number | null>(null)

  // 用 ref 持有回调：避免父级重渲染导致 effect 重启（重启会重新申请摄像头、白闪）
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult

  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    let cancelled = false
    let lastDecode = 0
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
        // ── 与 demo 一致的取流方式（对齐后才不再「放大」）─────────────────────
        // ① 枚举摄像头，取**最后一路**：demo 就是把它当后置主摄（真机取景正常）。
        //    用 `deviceId` 明确指定，而非 `facingMode`：多摄机型上 `facingMode:'environment'`
        //    可能选到非主摄（视野不同 → 观感「放大」）。
        // ② **不指定 width/height**：请求 1920×1080（16:9）会被 4:3 传感器上下裁切 → 视野变窄。
        // ③ **不做任何 `applyConstraints`**：demo 什么都没设，对焦交给系统就是完美的；
        //    强制 `focusMode` 在部分机型上会改变镜头 / 裁切（真机反馈的「放大」即来自此）。
        let cameras: MediaDeviceInfo[] = []
        try {
          cameras = (await navigator.mediaDevices.enumerateDevices()).filter(
            (d) => d.kind === 'videoinput' && d.deviceId,
          )
        } catch {
          cameras = []
        }
        const rear = cameras.length ? cameras[cameras.length - 1] : null
        const videoConstraints: MediaTrackConstraints = rear
          ? { deviceId: { exact: rear.deviceId } }
          : { facingMode: { ideal: 'environment' } }

        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        if (cancelled) return

        // 只探明能力（供手动工具条用）；**不主动设对焦**，避免改变取景。
        const track = stream.getVideoTracks()[0] ?? null
        trackRef.current = track
        setSupport(probeCameraSupport(track))
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
      if (slowTimer) clearTimeout(slowTimer)
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // 取景框尺寸跟随「视频按 contain 铺进屏幕后的实际显示框」（见 reticle 注释）
  useEffect(() => {
    if (!ready) return
    const compute = () => {
      const video = videoRef.current
      if (!video) return
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) return
      // 与 CSS 的 `object-fit: contain` 同一套算法：等比缩放至刚好放进屏幕
      const scale = Math.min(window.innerWidth / vw, window.innerHeight / vh)
      const side = Math.min(vw * scale, vh * scale) * 0.7
      setReticle(Math.round(side))
    }
    compute()
    const video = videoRef.current
    video?.addEventListener('loadedmetadata', compute)
    window.addEventListener('resize', compute)
    window.addEventListener('orientationchange', compute)
    return () => {
      video?.removeEventListener('loadedmetadata', compute)
      window.removeEventListener('resize', compute)
      window.removeEventListener('orientationchange', compute)
    }
  }, [ready])

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
      {/* 全屏取景：视频铺满整屏（`object-fit: cover`），不再限制在小方框里 */}
      <video ref={videoRef} className="scanner__video" playsInline muted />
      <canvas ref={canvasRef} className="scanner__canvas" />

      {/*
        取景框只是**视觉引导**（居中、四角括号，`pointer-events: none`）。
        解码其实覆盖**全帧**（见 `lib/scan-plan.ts`），码放在屏幕任意位置都能扫到。
      */}
      {ready && !error && (
        <div
          className="scanner__reticle"
          aria-hidden="true"
          style={reticle ? { width: reticle, height: reticle } : undefined}
        >
          <span className="scanner__corner scanner__corner--tl" />
          <span className="scanner__corner scanner__corner--tr" />
          <span className="scanner__corner scanner__corner--bl" />
          <span className="scanner__corner scanner__corner--br" />
        </div>
      )}

      {error ? (
        <div className="scanner__banner">
          <strong>无法使用摄像头</strong>
          <span>{error}</span>
        </div>
      ) : (
        <div className="scanner__hud">
          <p className="scanner__hint">将电脑端二维码放入画面，任意位置均可识别</p>

          {ready && !showsAnyTool && (
            <p className="scanner__notice">
              本机浏览器不允许网页控制对焦（iOS 上普遍如此，由系统接管）——
              若画面持续模糊，请把手机**拿远一点**（多数手机最近对焦距离约 10~20 厘米，凑太近任何软件都对不上）。
            </p>
          )}

          {slow && (
            <p className="scanner__notice">
              还扫不到？① 先拉到 25~35 厘米 —— 凑太近会低于镜头最近对焦距离（那种糊任何软件都无解），
              拉远后让二维码尽量充满取景框；② 稍微斜一点拍屏幕（正对易产生摩尔纹与反光）；
              ③ 或直接用下方「手动输入配对串」。
            </p>
          )}
        </div>
      )}

      <div className="scanner__controls">
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

        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          返回（改用手动输入）
        </button>
      </div>
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
