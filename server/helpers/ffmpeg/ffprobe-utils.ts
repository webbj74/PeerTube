import { FfprobeData } from 'fluent-ffmpeg'
import { getMaxBitrate } from '@shared/core-utils'
import {
  ffprobePromise,
  getAudioStream,
  getVideoStreamDuration,
  getMaxAudioBitrate,
  buildFileMetadata,
  getVideoStreamBitrate,
  getVideoStreamFPS,
  getVideoStream,
  getVideoStreamDimensionsInfo,
  hasAudioStream
} from '@shared/extra-utils/ffprobe'
import { VideoResolution, VideoTranscodingFPS } from '@shared/models'
import { CONFIG } from '../../initializers/config'
import { VIDEO_TRANSCODING_FPS } from '../../initializers/constants'
import { logger } from '../logger'

/**
 *
 * Helpers to run ffprobe and extract data from the JSON output
 *
 */

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

async function getVideoStreamCodec (path: string) {
  const videoStream = await getVideoStream(path)
  if (!videoStream) return ''

  const videoCodec = videoStream.codec_tag_string

  if (videoCodec === 'vp09') return 'vp09.00.50.08'
  if (videoCodec === 'hev1') return 'hev1.1.6.L93.B0'

  const baseProfileMatrix = {
    avc1: {
      High: '6400',
      Main: '4D40',
      Baseline: '42E0'
    },
    av01: {
      High: '1',
      Main: '0',
      Professional: '2'
    }
  }

  let baseProfile = baseProfileMatrix[videoCodec][videoStream.profile]
  if (!baseProfile) {
    logger.warn('Cannot get video profile codec of %s.', path, { videoStream })
    baseProfile = baseProfileMatrix[videoCodec]['High'] // Fallback
  }

  if (videoCodec === 'av01') {
    const level = videoStream.level

    // Guess the tier indicator and bit depth
    return `${videoCodec}.${baseProfile}.${level}M.08`
  }

  // Default, h264 codec
  let level = videoStream.level.toString(16)
  if (level.length === 1) level = `0${level}`

  return `${videoCodec}.${baseProfile}${level}`
}

async function getAudioStreamCodec (path: string, existingProbe?: FfprobeData) {
  const { audioStream } = await getAudioStream(path, existingProbe)

  if (!audioStream) return ''

  const audioCodecName = audioStream.codec_name

  if (audioCodecName === 'opus') return 'opus'
  if (audioCodecName === 'vorbis') return 'vorbis'
  if (audioCodecName === 'aac') return 'mp4a.40.2'

  logger.warn('Cannot get audio codec of %s.', path, { audioStream })

  return 'mp4a.40.2' // Fallback
}

// ---------------------------------------------------------------------------
// Resolutions
// ---------------------------------------------------------------------------

function computeLowerResolutionsToTranscode (videoFileResolution: number, type: 'vod' | 'live') {
  const configResolutions = type === 'vod'
    ? CONFIG.TRANSCODING.RESOLUTIONS
    : CONFIG.LIVE.TRANSCODING.RESOLUTIONS

  const resolutionsEnabled: number[] = []

  // Put in the order we want to proceed jobs
  const resolutions: VideoResolution[] = [
    VideoResolution.H_NOVIDEO,
    VideoResolution.H_480P,
    VideoResolution.H_360P,
    VideoResolution.H_720P,
    VideoResolution.H_240P,
    VideoResolution.H_144P,
    VideoResolution.H_1080P,
    VideoResolution.H_1440P,
    VideoResolution.H_4K
  ]

  for (const resolution of resolutions) {
    if (configResolutions[resolution + 'p'] === true && videoFileResolution > resolution) {
      resolutionsEnabled.push(resolution)
    }
  }

  return resolutionsEnabled
}

// ---------------------------------------------------------------------------
// Can quick transcode
// ---------------------------------------------------------------------------

async function canDoQuickTranscode (path: string): Promise<boolean> {
  if (CONFIG.TRANSCODING.PROFILE !== 'default') return false

  const probe = await ffprobePromise(path)

  return await canDoQuickVideoTranscode(path, probe) &&
         await canDoQuickAudioTranscode(path, probe)
}

async function canDoQuickAudioTranscode (path: string, probe?: FfprobeData): Promise<boolean> {
  const parsedAudio = await getAudioStream(path, probe)

  if (!parsedAudio.audioStream) return true

  if (parsedAudio.audioStream['codec_name'] !== 'aac') return false

  const audioBitrate = parsedAudio.bitrate
  if (!audioBitrate) return false

  const maxAudioBitrate = getMaxAudioBitrate('aac', audioBitrate)
  if (maxAudioBitrate !== -1 && audioBitrate > maxAudioBitrate) return false

  const channelLayout = parsedAudio.audioStream['channel_layout']
  // Causes playback issues with Chrome
  if (!channelLayout || channelLayout === 'unknown') return false

  return true
}

async function canDoQuickVideoTranscode (path: string, probe?: FfprobeData): Promise<boolean> {
  const videoStream = await getVideoStream(path, probe)
  const fps = await getVideoStreamFPS(path, probe)
  const bitRate = await getVideoStreamBitrate(path, probe)
  const resolutionData = await getVideoStreamDimensionsInfo(path, probe)

  // If ffprobe did not manage to guess the bitrate
  if (!bitRate) return false

  // check video params
  if (!videoStream) return false
  if (videoStream['codec_name'] !== 'h264') return false
  if (videoStream['pix_fmt'] !== 'yuv420p') return false
  if (fps < VIDEO_TRANSCODING_FPS.MIN || fps > VIDEO_TRANSCODING_FPS.MAX) return false
  if (bitRate > getMaxBitrate({ ...resolutionData, fps })) return false

  return true
}

// ---------------------------------------------------------------------------
// Framerate
// ---------------------------------------------------------------------------

function getClosestFramerateStandard <K extends keyof Pick<VideoTranscodingFPS, 'HD_STANDARD' | 'STANDARD'>> (fps: number, type: K) {
  return VIDEO_TRANSCODING_FPS[type].slice(0)
                                    .sort((a, b) => fps % a - fps % b)[0]
}

function computeFPS (fpsArg: number, resolution: VideoResolution) {
  let fps = fpsArg

  if (
    // On small/medium resolutions, limit FPS
    resolution !== undefined &&
    resolution < VIDEO_TRANSCODING_FPS.KEEP_ORIGIN_FPS_RESOLUTION_MIN &&
    fps > VIDEO_TRANSCODING_FPS.AVERAGE
  ) {
    // Get closest standard framerate by modulo: downsampling has to be done to a divisor of the nominal fps value
    fps = getClosestFramerateStandard(fps, 'STANDARD')
  }

  // Hard FPS limits
  if (fps > VIDEO_TRANSCODING_FPS.MAX) fps = getClosestFramerateStandard(fps, 'HD_STANDARD')

  if (fps < VIDEO_TRANSCODING_FPS.MIN) {
    throw new Error(`Cannot compute FPS because ${fps} is lower than our minimum value ${VIDEO_TRANSCODING_FPS.MIN}`)
  }

  return fps
}

// ---------------------------------------------------------------------------

export {
  // Re export ffprobe utils
  getVideoStreamDimensionsInfo,
  buildFileMetadata,
  getMaxAudioBitrate,
  getVideoStream,
  getVideoStreamDuration,
  getAudioStream,
  hasAudioStream,
  getVideoStreamFPS,
  ffprobePromise,
  getVideoStreamBitrate,

  getVideoStreamCodec,
  getAudioStreamCodec,

  computeFPS,
  getClosestFramerateStandard,

  computeLowerResolutionsToTranscode,

  canDoQuickTranscode,
  canDoQuickVideoTranscode,
  canDoQuickAudioTranscode
}
