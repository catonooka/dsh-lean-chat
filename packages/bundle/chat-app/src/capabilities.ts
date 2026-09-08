/**
 * Model input-modality detection. OpenAI-compatible `/models` lists carry no
 * capability metadata, so the only honest answer comes from the endpoint
 * itself: probe it with a minimal image and video part (max_tokens 1 — a
 * one-pixel PNG and a sub-second silent clip) and read acceptance or
 * rejection off the response.
 * @module @deepseek-ai/dsh-chat-app/capabilities
 */

/** One verdict per modality. `unknown` means the probe could not tell — auth
 * trouble, a rate limit, or an error that is not about the content type. */
export type ModalityVerdict = 'yes' | 'no' | 'unknown'

/** The whole capability answer for one model. */
export interface ModelAbilities {
  model: string
  image: ModalityVerdict
  video: ModalityVerdict
}

/** A 1x1 transparent PNG as a data URL. */
const PROBE_IMAGE_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A 0.2s silent 16x16 black mp4 as a data URL. */
const PROBE_VIDEO_URL = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAN1bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAp90cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAEAAABAAAAAAIXbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAyAAAACgBVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABwm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAYJzdGJsAAAAvnN0c2QAAAAAAAAAAQAAAK5hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2Mi4yOC4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANGF2Y0MBZAAK/+EAF2dkAAqs2V7ARAAAAwAEAAADAMg8SJZYAQAGaOvjyyLA/fj4AAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAHZIAAAAAAAAABhzdHRzAAAAAAAAAAEAAAAFAAACAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAOGN0dHMAAAAAAAAABQAAAAEAAAQAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAUAAAABAAAAKHN0c3oAAAAAAAAAAAAAAAUAAALFAAAADAAAAAwAAAAMAAAADAAAABRzdGNvAAAAAAAAAAEAAAOlAAAAYnVkdGEAAABabWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAtaWxzdAAAACWpdG9vAAAAHWRhdGEAAAABAAAAAExhdmY2Mi4xMi4xMDEAAAAIZnJlZQAAAv1tZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTI1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAD2WIhAAz//727L4FNhTIwQAAAAhBmiRsQr/+wAAAAAhBnkJ4hf/BgQAAAAgBnmF0Qr/EgAAAAAgBnmNqQr/EgQ=='

/**
 * The minimal multimodal user message for one modality: the fixture part
 * plus a one-word text part, exactly what a chat with an attachment sends.
 * @param kind - which input modality to probe.
 * @returns the messages array of the probe request.
 */
export function probeMessages(kind: 'image' | 'video'): { role: 'user'; content: unknown[] }[] {
  const url = kind === 'image' ? PROBE_IMAGE_URL : PROBE_VIDEO_URL
  const partType = kind === 'image' ? 'image_url' : 'video_url'
  return [{
    role: 'user',
    content: [
      { type: partType, [partType]: { url } },
      { type: 'text', text: 'hi' },
    ],
  }]
}

/** Rejections that are actually about the content type, not unrelated errors. */
const MODALITY_REJECT = /image|video|vision|multimodal|modality|content[ _-]?type|not[ _-]?support|unsupported/i

/**
 * Turn one probe response into a verdict: 2xx accepts the modality; a
 * client error that mentions the content type rejects it; everything else
 * (auth, rate limits, server errors, odd 400s) stays unknown.
 * @param status - the probe response's HTTP status.
 * @param bodyText - the probe response's body, for the rejection wording.
 * @returns the verdict for the probed modality.
 */
export function interpretProbeOutcome(status: number, bodyText: string): ModalityVerdict {
  if (status >= 200 && status < 300) return 'yes'
  if (status === 400 || status === 415 || status === 422) {
    return MODALITY_REJECT.test(bodyText) ? 'no' : 'unknown'
  }
  return 'unknown'
}

/** Where and how to reach the endpoint being probed. */
export interface ProbeTarget {
  /** OpenAI-compatible base URL, no trailing slash. */
  base: string
  /** Bearer key; may be empty for local endpoints. */
  apiKey: string
  /** The model id under test. */
  model: string
  /** Whole-probe budget per modality. */
  timeoutMs?: number
}

/** Run one modality probe; any transport failure stays unknown. */
async function probeOne(target: ProbeTarget, kind: 'image' | 'video'): Promise<ModalityVerdict> {
  try {
    const response = await fetch(`${target.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...target.apiKey !== '' ? { authorization: `Bearer ${target.apiKey}` } : {},
      },
      body: JSON.stringify({
        model: target.model,
        max_tokens: 1,
        messages: probeMessages(kind),
      }),
      signal: AbortSignal.timeout(target.timeoutMs ?? 15_000),
    })
    return interpretProbeOutcome(response.status, await response.text().catch(() => ''))
  } catch {
    return 'unknown'
  }
}

/**
 * Probe a model's image and video inputs in parallel.
 * @param target - the endpoint, key, and model to test.
 * @returns one verdict per modality.
 */
export async function probeModelAbilities(target: ProbeTarget): Promise<ModelAbilities> {
  const [image, video] = await Promise.all([probeOne(target, 'image'), probeOne(target, 'video')])
  return { model: target.model, image, video }
}
