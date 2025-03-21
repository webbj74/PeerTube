/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import 'mocha'
import * as chai from 'chai'
import { basename, join } from 'path'
import { ffprobePromise, getVideoStream } from '@server/helpers/ffmpeg'
import { checkLiveCleanup, checkLiveSegmentHash, checkResolutionsInMasterPlaylist, testImage } from '@server/tests/shared'
import { wait } from '@shared/core-utils'
import {
  HttpStatusCode,
  LiveVideo,
  LiveVideoCreate,
  LiveVideoLatencyMode,
  VideoDetails,
  VideoPrivacy,
  VideoState,
  VideoStreamingPlaylistType
} from '@shared/models'
import {
  cleanupTests,
  createMultipleServers,
  doubleFollow,
  killallServers,
  LiveCommand,
  makeRawRequest,
  PeerTubeServer,
  sendRTMPStream,
  setAccessTokensToServers,
  setDefaultVideoChannel,
  stopFfmpeg,
  testFfmpegStreamError,
  waitJobs,
  waitUntilLivePublishedOnAllServers
} from '@shared/server-commands'

const expect = chai.expect

describe('Test live', function () {
  let servers: PeerTubeServer[] = []
  let commands: LiveCommand[]

  before(async function () {
    this.timeout(120000)

    servers = await createMultipleServers(2)

    // Get the access tokens
    await setAccessTokensToServers(servers)
    await setDefaultVideoChannel(servers)

    await servers[0].config.updateCustomSubConfig({
      newConfig: {
        live: {
          enabled: true,
          allowReplay: true,
          latencySetting: {
            enabled: true
          },
          transcoding: {
            enabled: false
          }
        }
      }
    })

    // Server 1 and server 2 follow each other
    await doubleFollow(servers[0], servers[1])

    commands = servers.map(s => s.live)
  })

  describe('Live creation, update and delete', function () {
    let liveVideoUUID: string

    it('Should create a live with the appropriate parameters', async function () {
      this.timeout(20000)

      const attributes: LiveVideoCreate = {
        category: 1,
        licence: 2,
        language: 'fr',
        description: 'super live description',
        support: 'support field',
        channelId: servers[0].store.channel.id,
        nsfw: false,
        waitTranscoding: false,
        name: 'my super live',
        tags: [ 'tag1', 'tag2' ],
        commentsEnabled: false,
        downloadEnabled: false,
        saveReplay: true,
        latencyMode: LiveVideoLatencyMode.SMALL_LATENCY,
        privacy: VideoPrivacy.PUBLIC,
        previewfile: 'video_short1-preview.webm.jpg',
        thumbnailfile: 'video_short1.webm.jpg'
      }

      const live = await commands[0].create({ fields: attributes })
      liveVideoUUID = live.uuid

      await waitJobs(servers)

      for (const server of servers) {
        const video = await server.videos.get({ id: liveVideoUUID })

        expect(video.category.id).to.equal(1)
        expect(video.licence.id).to.equal(2)
        expect(video.language.id).to.equal('fr')
        expect(video.description).to.equal('super live description')
        expect(video.support).to.equal('support field')

        expect(video.channel.name).to.equal(servers[0].store.channel.name)
        expect(video.channel.host).to.equal(servers[0].store.channel.host)

        expect(video.isLive).to.be.true

        expect(video.nsfw).to.be.false
        expect(video.waitTranscoding).to.be.false
        expect(video.name).to.equal('my super live')
        expect(video.tags).to.deep.equal([ 'tag1', 'tag2' ])
        expect(video.commentsEnabled).to.be.false
        expect(video.downloadEnabled).to.be.false
        expect(video.privacy.id).to.equal(VideoPrivacy.PUBLIC)

        await testImage(server.url, 'video_short1-preview.webm', video.previewPath)
        await testImage(server.url, 'video_short1.webm', video.thumbnailPath)

        const live = await server.live.get({ videoId: liveVideoUUID })

        if (server.url === servers[0].url) {
          expect(live.rtmpUrl).to.equal('rtmp://' + server.hostname + ':' + servers[0].rtmpPort + '/live')
          expect(live.streamKey).to.not.be.empty
        } else {
          expect(live.rtmpUrl).to.not.exist
          expect(live.streamKey).to.not.exist
        }

        expect(live.saveReplay).to.be.true
        expect(live.latencyMode).to.equal(LiveVideoLatencyMode.SMALL_LATENCY)
      }
    })

    it('Should have a default preview and thumbnail', async function () {
      this.timeout(20000)

      const attributes: LiveVideoCreate = {
        name: 'default live thumbnail',
        channelId: servers[0].store.channel.id,
        privacy: VideoPrivacy.UNLISTED,
        nsfw: true
      }

      const live = await commands[0].create({ fields: attributes })
      const videoId = live.uuid

      await waitJobs(servers)

      for (const server of servers) {
        const video = await server.videos.get({ id: videoId })
        expect(video.privacy.id).to.equal(VideoPrivacy.UNLISTED)
        expect(video.nsfw).to.be.true

        await makeRawRequest(server.url + video.thumbnailPath, HttpStatusCode.OK_200)
        await makeRawRequest(server.url + video.previewPath, HttpStatusCode.OK_200)
      }
    })

    it('Should not have the live listed since nobody streams into', async function () {
      for (const server of servers) {
        const { total, data } = await server.videos.list()

        expect(total).to.equal(0)
        expect(data).to.have.lengthOf(0)
      }
    })

    it('Should not be able to update a live of another server', async function () {
      await commands[1].update({ videoId: liveVideoUUID, fields: { saveReplay: false }, expectedStatus: HttpStatusCode.FORBIDDEN_403 })
    })

    it('Should update the live', async function () {
      this.timeout(10000)

      await commands[0].update({ videoId: liveVideoUUID, fields: { saveReplay: false, latencyMode: LiveVideoLatencyMode.DEFAULT } })
      await waitJobs(servers)
    })

    it('Have the live updated', async function () {
      for (const server of servers) {
        const live = await server.live.get({ videoId: liveVideoUUID })

        if (server.url === servers[0].url) {
          expect(live.rtmpUrl).to.equal('rtmp://' + server.hostname + ':' + servers[0].rtmpPort + '/live')
          expect(live.streamKey).to.not.be.empty
        } else {
          expect(live.rtmpUrl).to.not.exist
          expect(live.streamKey).to.not.exist
        }

        expect(live.saveReplay).to.be.false
        expect(live.latencyMode).to.equal(LiveVideoLatencyMode.DEFAULT)
      }
    })

    it('Delete the live', async function () {
      this.timeout(10000)

      await servers[0].videos.remove({ id: liveVideoUUID })
      await waitJobs(servers)
    })

    it('Should have the live deleted', async function () {
      for (const server of servers) {
        await server.videos.get({ id: liveVideoUUID, expectedStatus: HttpStatusCode.NOT_FOUND_404 })
        await server.live.get({ videoId: liveVideoUUID, expectedStatus: HttpStatusCode.NOT_FOUND_404 })
      }
    })
  })

  describe('Live filters', function () {
    let ffmpegCommand: any
    let liveVideoId: string
    let vodVideoId: string

    before(async function () {
      this.timeout(120000)

      vodVideoId = (await servers[0].videos.quickUpload({ name: 'vod video' })).uuid

      const liveOptions = { name: 'live', privacy: VideoPrivacy.PUBLIC, channelId: servers[0].store.channel.id }
      const live = await commands[0].create({ fields: liveOptions })
      liveVideoId = live.uuid

      ffmpegCommand = await servers[0].live.sendRTMPStreamInVideo({ videoId: liveVideoId })
      await waitUntilLivePublishedOnAllServers(servers, liveVideoId)
      await waitJobs(servers)
    })

    it('Should only display lives', async function () {
      const { data, total } = await servers[0].videos.list({ isLive: true })

      expect(total).to.equal(1)
      expect(data).to.have.lengthOf(1)
      expect(data[0].name).to.equal('live')
    })

    it('Should not display lives', async function () {
      const { data, total } = await servers[0].videos.list({ isLive: false })

      expect(total).to.equal(1)
      expect(data).to.have.lengthOf(1)
      expect(data[0].name).to.equal('vod video')
    })

    it('Should display my lives', async function () {
      this.timeout(60000)

      await stopFfmpeg(ffmpegCommand)
      await waitJobs(servers)

      const { data } = await servers[0].videos.listMyVideos({ isLive: true })

      const result = data.every(v => v.isLive)
      expect(result).to.be.true
    })

    it('Should not display my lives', async function () {
      const { data } = await servers[0].videos.listMyVideos({ isLive: false })

      const result = data.every(v => !v.isLive)
      expect(result).to.be.true
    })

    after(async function () {
      await servers[0].videos.remove({ id: vodVideoId })
      await servers[0].videos.remove({ id: liveVideoId })
    })
  })

  describe('Stream checks', function () {
    let liveVideo: LiveVideo & VideoDetails
    let rtmpUrl: string

    before(function () {
      rtmpUrl = 'rtmp://' + servers[0].hostname + ':' + servers[0].rtmpPort + ''
    })

    async function createLiveWrapper () {
      const liveAttributes = {
        name: 'user live',
        channelId: servers[0].store.channel.id,
        privacy: VideoPrivacy.PUBLIC,
        saveReplay: false
      }

      const { uuid } = await commands[0].create({ fields: liveAttributes })

      const live = await commands[0].get({ videoId: uuid })
      const video = await servers[0].videos.get({ id: uuid })

      return Object.assign(video, live)
    }

    it('Should not allow a stream without the appropriate path', async function () {
      this.timeout(60000)

      liveVideo = await createLiveWrapper()

      const command = sendRTMPStream({ rtmpBaseUrl: rtmpUrl + '/bad-live', streamKey: liveVideo.streamKey })
      await testFfmpegStreamError(command, true)
    })

    it('Should not allow a stream without the appropriate stream key', async function () {
      this.timeout(60000)

      const command = sendRTMPStream({ rtmpBaseUrl: rtmpUrl + '/live', streamKey: 'bad-stream-key' })
      await testFfmpegStreamError(command, true)
    })

    it('Should succeed with the correct params', async function () {
      this.timeout(60000)

      const command = sendRTMPStream({ rtmpBaseUrl: rtmpUrl + '/live', streamKey: liveVideo.streamKey })
      await testFfmpegStreamError(command, false)
    })

    it('Should list this live now someone stream into it', async function () {
      for (const server of servers) {
        const { total, data } = await server.videos.list()

        expect(total).to.equal(1)
        expect(data).to.have.lengthOf(1)

        const video = data[0]
        expect(video.name).to.equal('user live')
        expect(video.isLive).to.be.true
      }
    })

    it('Should not allow a stream on a live that was blacklisted', async function () {
      this.timeout(60000)

      liveVideo = await createLiveWrapper()

      await servers[0].blacklist.add({ videoId: liveVideo.uuid })

      const command = sendRTMPStream({ rtmpBaseUrl: rtmpUrl + '/live', streamKey: liveVideo.streamKey })
      await testFfmpegStreamError(command, true)
    })

    it('Should not allow a stream on a live that was deleted', async function () {
      this.timeout(60000)

      liveVideo = await createLiveWrapper()

      await servers[0].videos.remove({ id: liveVideo.uuid })

      const command = sendRTMPStream({ rtmpBaseUrl: rtmpUrl + '/live', streamKey: liveVideo.streamKey })
      await testFfmpegStreamError(command, true)
    })
  })

  describe('Live transcoding', function () {
    let liveVideoId: string

    async function createLiveWrapper (saveReplay: boolean) {
      const liveAttributes = {
        name: 'live video',
        channelId: servers[0].store.channel.id,
        privacy: VideoPrivacy.PUBLIC,
        saveReplay
      }

      const { uuid } = await commands[0].create({ fields: liveAttributes })
      return uuid
    }

    async function testVideoResolutions (liveVideoId: string, resolutions: number[]) {
      for (const server of servers) {
        const { data } = await server.videos.list()
        expect(data.find(v => v.uuid === liveVideoId)).to.exist

        const video = await server.videos.get({ id: liveVideoId })

        expect(video.streamingPlaylists).to.have.lengthOf(1)

        const hlsPlaylist = video.streamingPlaylists.find(s => s.type === VideoStreamingPlaylistType.HLS)
        expect(hlsPlaylist).to.exist

        // Only finite files are displayed
        expect(hlsPlaylist.files).to.have.lengthOf(0)

        await checkResolutionsInMasterPlaylist({ server, playlistUrl: hlsPlaylist.playlistUrl, resolutions })

        for (let i = 0; i < resolutions.length; i++) {
          const segmentNum = 3
          const segmentName = `${i}-00000${segmentNum}.ts`
          await commands[0].waitUntilSegmentGeneration({ videoUUID: video.uuid, resolution: i, segment: segmentNum })

          const subPlaylist = await servers[0].streamingPlaylists.get({
            url: `${servers[0].url}/static/streaming-playlists/hls/${video.uuid}/${i}.m3u8`
          })

          expect(subPlaylist).to.contain(segmentName)

          const baseUrlAndPath = servers[0].url + '/static/streaming-playlists/hls'
          await checkLiveSegmentHash({
            server,
            baseUrlSegment: baseUrlAndPath,
            videoUUID: video.uuid,
            segmentName,
            hlsPlaylist
          })
        }
      }
    }

    function updateConf (resolutions: number[]) {
      return servers[0].config.updateCustomSubConfig({
        newConfig: {
          live: {
            enabled: true,
            allowReplay: true,
            maxDuration: -1,
            transcoding: {
              enabled: true,
              resolutions: {
                '144p': resolutions.includes(144),
                '240p': resolutions.includes(240),
                '360p': resolutions.includes(360),
                '480p': resolutions.includes(480),
                '720p': resolutions.includes(720),
                '1080p': resolutions.includes(1080),
                '2160p': resolutions.includes(2160)
              }
            }
          }
        }
      })
    }

    before(async function () {
      await updateConf([])
    })

    it('Should enable transcoding without additional resolutions', async function () {
      this.timeout(120000)

      liveVideoId = await createLiveWrapper(false)

      const ffmpegCommand = await commands[0].sendRTMPStreamInVideo({ videoId: liveVideoId })
      await waitUntilLivePublishedOnAllServers(servers, liveVideoId)
      await waitJobs(servers)

      await testVideoResolutions(liveVideoId, [ 720 ])

      await stopFfmpeg(ffmpegCommand)
    })

    it('Should enable transcoding with some resolutions', async function () {
      this.timeout(120000)

      const resolutions = [ 240, 480 ]
      await updateConf(resolutions)
      liveVideoId = await createLiveWrapper(false)

      const ffmpegCommand = await commands[0].sendRTMPStreamInVideo({ videoId: liveVideoId })
      await waitUntilLivePublishedOnAllServers(servers, liveVideoId)
      await waitJobs(servers)

      await testVideoResolutions(liveVideoId, resolutions)

      await stopFfmpeg(ffmpegCommand)
    })

    it('Should correctly set the appropriate bitrate depending on the input', async function () {
      this.timeout(120000)

      liveVideoId = await createLiveWrapper(false)

      const ffmpegCommand = await commands[0].sendRTMPStreamInVideo({
        videoId: liveVideoId,
        fixtureName: 'video_short.mp4',
        copyCodecs: true
      })
      await waitUntilLivePublishedOnAllServers(servers, liveVideoId)
      await waitJobs(servers)

      const video = await servers[0].videos.get({ id: liveVideoId })

      const masterPlaylist = video.streamingPlaylists[0].playlistUrl
      const probe = await ffprobePromise(masterPlaylist)

      const bitrates = probe.streams.map(s => parseInt(s.tags.variant_bitrate))
      for (const bitrate of bitrates) {
        expect(bitrate).to.exist
        expect(isNaN(bitrate)).to.be.false
        expect(bitrate).to.be.below(61_000_000) // video_short.mp4 bitrate
      }

      await stopFfmpeg(ffmpegCommand)
    })

    it('Should enable transcoding with some resolutions and correctly save them', async function () {
      this.timeout(400_000)

      const resolutions = [ 240, 360, 720 ]

      await updateConf(resolutions)
      liveVideoId = await createLiveWrapper(true)

      const ffmpegCommand = await commands[0].sendRTMPStreamInVideo({ videoId: liveVideoId, fixtureName: 'video_short2.webm' })
      await waitUntilLivePublishedOnAllServers(servers, liveVideoId)
      await waitJobs(servers)

      await testVideoResolutions(liveVideoId, resolutions)

      await stopFfmpeg(ffmpegCommand)
      await commands[0].waitUntilEnded({ videoId: liveVideoId })

      await waitJobs(servers)

      await waitUntilLivePublishedOnAllServers(servers, liveVideoId)

      const maxBitrateLimits = {
        720: 6500 * 1000, // 60FPS
        360: 1250 * 1000,
        240: 700 * 1000
      }

      const minBitrateLimits = {
        720: 5500 * 1000,
        360: 1000 * 1000,
        240: 550 * 1000
      }

      for (const server of servers) {
        const video = await server.videos.get({ id: liveVideoId })

        expect(video.state.id).to.equal(VideoState.PUBLISHED)
        expect(video.duration).to.be.greaterThan(1)
        expect(video.files).to.have.lengthOf(0)

        const hlsPlaylist = video.streamingPlaylists.find(s => s.type === VideoStreamingPlaylistType.HLS)
        await makeRawRequest(hlsPlaylist.playlistUrl, HttpStatusCode.OK_200)
        await makeRawRequest(hlsPlaylist.segmentsSha256Url, HttpStatusCode.OK_200)

        // We should have generated random filenames
        expect(basename(hlsPlaylist.playlistUrl)).to.not.equal('master.m3u8')
        expect(basename(hlsPlaylist.segmentsSha256Url)).to.not.equal('segments-sha256.json')

        expect(hlsPlaylist.files).to.have.lengthOf(resolutions.length)

        for (const resolution of resolutions) {
          const file = hlsPlaylist.files.find(f => f.resolution.id === resolution)

          expect(file).to.exist
          expect(file.size).to.be.greaterThan(1)

          if (resolution >= 720) {
            expect(file.fps).to.be.approximately(60, 2)
          } else {
            expect(file.fps).to.be.approximately(30, 2)
          }

          const filename = basename(file.fileUrl)
          expect(filename).to.not.contain(video.uuid)

          const segmentPath = servers[0].servers.buildDirectory(join('streaming-playlists', 'hls', video.uuid, filename))

          const probe = await ffprobePromise(segmentPath)
          const videoStream = await getVideoStream(segmentPath, probe)

          expect(probe.format.bit_rate).to.be.below(maxBitrateLimits[videoStream.height])
          expect(probe.format.bit_rate).to.be.at.least(minBitrateLimits[videoStream.height])

          await makeRawRequest(file.torrentUrl, HttpStatusCode.OK_200)
          await makeRawRequest(file.fileUrl, HttpStatusCode.OK_200)
        }
      }
    })

    it('Should correctly have cleaned up the live files', async function () {
      this.timeout(30000)

      await checkLiveCleanup(servers[0], liveVideoId, [ 240, 360, 720 ])
    })
  })

  describe('After a server restart', function () {
    let liveVideoId: string
    let liveVideoReplayId: string
    let permanentLiveVideoReplayId: string

    let permanentLiveReplayName: string

    let beforeServerRestart: Date

    async function createLiveWrapper (options: { saveReplay: boolean, permanent: boolean }) {
      const liveAttributes: LiveVideoCreate = {
        name: 'live video',
        channelId: servers[0].store.channel.id,
        privacy: VideoPrivacy.PUBLIC,
        saveReplay: options.saveReplay,
        permanentLive: options.permanent
      }

      const { uuid } = await commands[0].create({ fields: liveAttributes })
      return uuid
    }

    before(async function () {
      this.timeout(160000)

      liveVideoId = await createLiveWrapper({ saveReplay: false, permanent: false })
      liveVideoReplayId = await createLiveWrapper({ saveReplay: true, permanent: false })
      permanentLiveVideoReplayId = await createLiveWrapper({ saveReplay: true, permanent: true })

      await Promise.all([
        commands[0].sendRTMPStreamInVideo({ videoId: liveVideoId }),
        commands[0].sendRTMPStreamInVideo({ videoId: permanentLiveVideoReplayId }),
        commands[0].sendRTMPStreamInVideo({ videoId: liveVideoReplayId })
      ])

      await Promise.all([
        commands[0].waitUntilPublished({ videoId: liveVideoId }),
        commands[0].waitUntilPublished({ videoId: permanentLiveVideoReplayId }),
        commands[0].waitUntilPublished({ videoId: liveVideoReplayId })
      ])

      await commands[0].waitUntilSegmentGeneration({ videoUUID: liveVideoId, resolution: 0, segment: 2 })
      await commands[0].waitUntilSegmentGeneration({ videoUUID: liveVideoReplayId, resolution: 0, segment: 2 })
      await commands[0].waitUntilSegmentGeneration({ videoUUID: permanentLiveVideoReplayId, resolution: 0, segment: 2 })

      {
        const video = await servers[0].videos.get({ id: permanentLiveVideoReplayId })
        permanentLiveReplayName = video.name + ' - ' + new Date(video.publishedAt).toLocaleString()
      }

      await killallServers([ servers[0] ])

      beforeServerRestart = new Date()
      await servers[0].run()

      await wait(5000)
      await waitJobs(servers)
    })

    it('Should cleanup lives', async function () {
      this.timeout(60000)

      await commands[0].waitUntilEnded({ videoId: liveVideoId })
      await commands[0].waitUntilWaiting({ videoId: permanentLiveVideoReplayId })
    })

    it('Should save a non permanent live replay', async function () {
      this.timeout(240000)

      await commands[0].waitUntilPublished({ videoId: liveVideoReplayId })

      const session = await commands[0].getReplaySession({ videoId: liveVideoReplayId })
      expect(session.endDate).to.exist
      expect(new Date(session.endDate)).to.be.above(beforeServerRestart)
    })

    it('Should have saved a permanent live replay', async function () {
      this.timeout(120000)

      const { data } = await servers[0].videos.listMyVideos({ sort: '-publishedAt' })
      expect(data.find(v => v.name === permanentLiveReplayName)).to.exist
    })
  })

  after(async function () {
    await cleanupTests(servers)
  })
})
