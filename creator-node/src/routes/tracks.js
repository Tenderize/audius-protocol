const fs = require('fs')
const { Buffer } = require('ipfs-http-client')
const { promisify } = require('util')

const config = require('../config.js')
const models = require('../models')
const {
  saveFileFromBufferToIPFSAndDisk,
  removeTrackFolder,
  handleTrackContentUpload
} = require('../fileManager')
const {
  handleResponse,
  sendResponse,
  successResponse,
  errorResponseBadRequest,
  errorResponseServerError,
  errorResponseForbidden
} = require('../apiHelpers')
const { validateStateForImageDirCIDAndReturnFileUUID } = require('../utils')
const {
  authMiddleware,
  ensurePrimaryMiddleware,
  syncLockMiddleware,
  issueAndWaitForSecondarySyncRequests,
  ensureStorageMiddleware
} = require('../middlewares')

const { getCID } = require('./files')
const { decode } = require('../hashids.js')
const RehydrateIpfsQueue = require('../RehydrateIpfsQueue')
const { FileProcessingQueue } = require('../FileProcessingQueue')
const DBManager = require('../dbManager')
const { generateListenTimestampAndSignature } = require('../apiSigning.js')
const BlacklistManager = require('../blacklistManager')

const ENABLE_IPFS_ADD_METADATA = config.get('enableIPFSAddMetadata')

const readFile = promisify(fs.readFile)

module.exports = function (app) {
  /**
   * Add a track transcode task into the worker queue. If the track file is uploaded properly (not transcoded), return successResponse
   * @note this track content route is used in conjunction with the polling.
   */
  app.post(
    '/track_content_async',
    authMiddleware,
    ensurePrimaryMiddleware,
    ensureStorageMiddleware,
    syncLockMiddleware,
    handleTrackContentUpload,
    handleResponse(async (req, res) => {
      if (req.fileSizeError || req.fileFilterError) {
        removeTrackFolder({ logContext: req.logContext }, req.fileDir)
        return errorResponseBadRequest(req.fileSizeError || req.fileFilterError)
      }

      await FileProcessingQueue.addTranscodeTask({
        logContext: req.logContext,
        req: {
          fileName: req.fileName,
          fileDir: req.fileDir,
          fileDestination: req.file.destination,
          session: {
            cnodeUserUUID: req.session.cnodeUserUUID
          }
        }
      })
      return successResponse({ uuid: req.logContext.requestID })
    })
  )

  /**
   * Given track metadata object, upload and share metadata to IPFS. Return metadata multihash if successful.
   * Error if associated track segments have not already been created and stored.
   */
  app.post(
    '/tracks/metadata',
    authMiddleware,
    ensurePrimaryMiddleware,
    ensureStorageMiddleware,
    syncLockMiddleware,
    handleResponse(async (req, res) => {
      const metadataJSON = req.body.metadata

      if (
        !metadataJSON ||
        !metadataJSON.owner_id ||
        !metadataJSON.track_segments ||
        !Array.isArray(metadataJSON.track_segments) ||
        !metadataJSON.track_segments.length
      ) {
        return errorResponseBadRequest(
          'Metadata object must include owner_id and non-empty track_segments array'
        )
      }

      // If metadata indicates track is downloadable but doesn't provide a transcode CID,
      //    ensure that a transcoded master record exists in DB
      if (
        metadataJSON.download &&
        metadataJSON.download.is_downloadable &&
        !metadataJSON.download.cid
      ) {
        const sourceFile = req.body.sourceFile
        const trackId = metadataJSON.track_id
        if (!sourceFile && !trackId) {
          return errorResponseBadRequest(
            'Cannot make downloadable - A sourceFile must be provided or the metadata object must include track_id'
          )
        }

        // See if the track already has a transcoded master
        if (trackId) {
          const { blockchainId } = await models.Track.findOne({
            attributes: ['blockchainId'],
            where: {
              blockchainId: trackId
            },
            order: [['clock', 'DESC']]
          })

          // Error if no DB entry for transcode found
          const transcodedFile = await models.File.findOne({
            attributes: ['multihash'],
            where: {
              cnodeUserUUID: req.session.cnodeUserUUID,
              type: 'copy320',
              trackBlockchainId: blockchainId
            }
          })
          if (!transcodedFile) {
            return errorResponseServerError('Failed to find transcoded file')
          }
        }
      }

      const metadataBuffer = Buffer.from(JSON.stringify(metadataJSON))
      const cnodeUserUUID = req.session.cnodeUserUUID

      // Save file from buffer to IPFS and disk
      let multihash, dstPath
      try {
        const resp = await saveFileFromBufferToIPFSAndDisk(
          req,
          metadataBuffer,
          ENABLE_IPFS_ADD_METADATA
        )
        multihash = resp.multihash
        dstPath = resp.dstPath
      } catch (e) {
        return errorResponseServerError(
          `/tracks/metadata saveFileFromBufferToIPFSAndDisk op failed: ${e}`
        )
      }

      // Record metadata file entry in DB
      const transaction = await models.sequelize.transaction()
      let fileUUID
      try {
        const createFileQueryObj = {
          multihash,
          sourceFile: req.fileName,
          storagePath: dstPath,
          type: 'metadata' // TODO - replace with models enum
        }
        const file = await DBManager.createNewDataRecord(
          createFileQueryObj,
          cnodeUserUUID,
          models.File,
          transaction
        )
        fileUUID = file.fileUUID

        await transaction.commit()
      } catch (e) {
        await transaction.rollback()
        return errorResponseServerError(`Could not save to db db: ${e}`)
      }

      return successResponse({
        metadataMultihash: multihash,
        metadataFileUUID: fileUUID
      })
    })
  )

  /**
   * Given track blockchainTrackId, blockNumber, and metadataFileUUID, creates/updates Track DB track entry
   * and associates segment & image file entries with track. Ends track creation/update process.
   */
  app.post(
    '/tracks',
    authMiddleware,
    ensurePrimaryMiddleware,
    ensureStorageMiddleware,
    syncLockMiddleware,
    handleResponse(async (req, res) => {
      const {
        blockchainTrackId,
        blockNumber,
        metadataFileUUID,
        transcodedTrackUUID
      } = req.body

      // Input validation
      if (!blockchainTrackId || !blockNumber || !metadataFileUUID) {
        return errorResponseBadRequest(
          'Must include blockchainTrackId, blockNumber, and metadataFileUUID.'
        )
      }

      // Error on outdated blocknumber
      const cnodeUser = req.session.cnodeUser
      if (blockNumber < cnodeUser.latestBlockNumber) {
        return errorResponseBadRequest(
          `Invalid blockNumber param ${blockNumber}. Must be greater or equal to previously processed blocknumber ${cnodeUser.latestBlockNumber}.`
        )
      }
      const cnodeUserUUID = req.session.cnodeUserUUID

      // Fetch metadataJSON for metadataFileUUID, error if not found or malformatted
      const file = await models.File.findOne({
        where: { fileUUID: metadataFileUUID, cnodeUserUUID }
      })
      if (!file) {
        return errorResponseBadRequest(
          `No file db record found for provided metadataFileUUID ${metadataFileUUID}.`
        )
      }
      let metadataJSON
      try {
        const fileBuffer = await readFile(file.storagePath)
        metadataJSON = JSON.parse(fileBuffer)
        if (
          !metadataJSON ||
          !metadataJSON.track_segments ||
          !Array.isArray(metadataJSON.track_segments) ||
          !metadataJSON.track_segments.length
        ) {
          return errorResponseServerError(
            `Malformatted metadataJSON stored for metadataFileUUID ${metadataFileUUID}.`
          )
        }
      } catch (e) {
        return errorResponseServerError(
          `No file stored on disk for metadataFileUUID ${metadataFileUUID} at storagePath ${file.storagePath}.`
        )
      }

      // Get coverArtFileUUID for multihash in metadata object, else error
      let coverArtFileUUID
      try {
        coverArtFileUUID = await validateStateForImageDirCIDAndReturnFileUUID(
          req,
          metadataJSON.cover_art_sizes
        )
      } catch (e) {
        return errorResponseServerError(e.message)
      }

      const transaction = await models.sequelize.transaction()
      try {
        const existingTrackEntry = await models.Track.findOne({
          where: {
            cnodeUserUUID,
            blockchainId: blockchainTrackId
          },
          order: [['clock', 'DESC']],
          transaction
        })

        // Insert track entry in DB
        const createTrackQueryObj = {
          metadataFileUUID,
          metadataJSON,
          blockchainId: blockchainTrackId,
          coverArtFileUUID
        }
        const track = await DBManager.createNewDataRecord(
          createTrackQueryObj,
          cnodeUserUUID,
          models.Track,
          transaction
        )

        /**
         * Associate matching transcode & segment files on DB with new/updated track
         * Must be done in same transaction to atomicity
         *
         * TODO - consider implications of edge-case -> two attempted /track_content before associate
         */

        const trackSegmentCIDs = metadataJSON.track_segments.map(
          (segment) => segment.multihash
        )

        // if track created, ensure files exist with trackBlockchainId = null and update them
        if (!existingTrackEntry) {
          // Associate the transcode file db record with trackUUID
          if (transcodedTrackUUID) {
            const transcodedFile = await models.File.findOne({
              where: {
                fileUUID: transcodedTrackUUID,
                cnodeUserUUID,
                trackBlockchainId: null,
                type: 'copy320'
              },
              transaction
            })
            if (!transcodedFile) {
              throw new Error(
                'Did not find a transcoded file for the provided CID.'
              )
            }
            const numAffectedRows = await models.File.update(
              { trackBlockchainId: track.blockchainId },
              {
                where: {
                  fileUUID: transcodedTrackUUID,
                  cnodeUserUUID,
                  trackBlockchainId: null,
                  type: 'copy320' // TODO - replace with model enum
                },
                transaction
              }
            )
            if (numAffectedRows === 0) {
              throw new Error(
                'Failed to associate the transcoded file for the provided track UUID.'
              )
            }
          }

          // Associate all segment file db records with trackUUID
          const trackFiles = await models.File.findAll({
            where: {
              multihash: trackSegmentCIDs,
              cnodeUserUUID,
              trackBlockchainId: null,
              type: 'track'
            },
            transaction
          })

          if (trackFiles.length < trackSegmentCIDs.length) {
            req.logger.error(
              `Did not find files for every track segment CID for user ${cnodeUserUUID} ${trackFiles} ${trackSegmentCIDs}`
            )
            throw new Error('Did not find files for every track segment CID.')
          }
          const numAffectedRows = await models.File.update(
            { trackBlockchainId: track.blockchainId },
            {
              where: {
                multihash: trackSegmentCIDs,
                cnodeUserUUID,
                trackBlockchainId: null,
                type: 'track'
              },
              transaction
            }
          )
          if (parseInt(numAffectedRows, 10) < trackSegmentCIDs.length) {
            req.logger.error(
              `Failed to associate files for every track segment CID ${cnodeUserUUID} ${track.blockchainId} ${numAffectedRows} ${trackSegmentCIDs.length}`
            )
            throw new Error(
              'Failed to associate files for every track segment CID.'
            )
          }
        } else {
          /** If track updated, ensure files exist with trackBlockchainId. */
          // Ensure transcode file db record exists if uuid provided
          if (transcodedTrackUUID) {
            const transcodedFile = await models.File.findOne({
              where: {
                fileUUID: transcodedTrackUUID,
                cnodeUserUUID,
                trackBlockchainId: track.blockchainId,
                type: 'copy320'
              },
              transaction
            })
            if (!transcodedFile) {
              throw new Error(
                'Did not find the corresponding transcoded file for the provided track UUID.'
              )
            }
          }

          // Ensure segment file db records exist for all CIDs
          const trackFiles = await models.File.findAll({
            where: {
              multihash: trackSegmentCIDs,
              cnodeUserUUID,
              trackBlockchainId: track.blockchainId,
              type: 'track'
            },
            transaction
          })
          if (trackFiles.length < trackSegmentCIDs.length) {
            throw new Error(
              'Did not find files for every track segment CID with trackBlockchainId.'
            )
          }
        }

        // Update cnodeUser's latestBlockNumber if higher than previous latestBlockNumber.
        // TODO - move to subquery to guarantee atomicity.
        const updatedCNodeUser = await models.CNodeUser.findOne({
          where: { cnodeUserUUID },
          transaction
        })
        if (!updatedCNodeUser || !updatedCNodeUser.latestBlockNumber) {
          throw new Error('Issue in retrieving udpatedCnodeUser')
        }
        req.logger.info(
          `cnodeuser ${cnodeUserUUID} first latestBlockNumber ${cnodeUser.latestBlockNumber} || \
        current latestBlockNumber ${updatedCNodeUser.latestBlockNumber} || \
        given blockNumber ${blockNumber}`
        )
        if (blockNumber > updatedCNodeUser.latestBlockNumber) {
          // Update cnodeUser's latestBlockNumber
          await cnodeUser.update(
            { latestBlockNumber: blockNumber },
            { transaction }
          )
        }

        await transaction.commit()

        await issueAndWaitForSecondarySyncRequests(req)

        return successResponse()
      } catch (e) {
        req.logger.error(e.message)
        await transaction.rollback()
        return errorResponseServerError(e.message)
      }
    })
  )

  /** Returns download status of track and 320kbps CID if ready + downloadable. */
  app.get(
    '/tracks/download_status/:blockchainId',
    handleResponse(async (req, res) => {
      const blockchainId = req.params.blockchainId
      if (!blockchainId) {
        return errorResponseBadRequest('Please provide blockchainId.')
      }

      const track = await models.Track.findOne({
        where: { blockchainId },
        order: [['clock', 'DESC']]
      })
      if (!track) {
        return errorResponseBadRequest(
          `No track found for blockchainId ${blockchainId}`
        )
      }

      // Case: track is not marked as downloadable
      if (
        !track.metadataJSON ||
        !track.metadataJSON.download ||
        !track.metadataJSON.download.is_downloadable
      ) {
        return successResponse({ isDownloadable: false, cid: null })
      }

      // Case: track is marked as downloadable
      // - Check if downloadable file exists. Since copyFile may or may not have trackBlockchainId association,
      //    fetch a segmentFile for trackBlockchainId, and find copyFile for segmentFile's sourceFile.
      const segmentFile = await models.File.findOne({
        where: {
          type: 'track',
          trackBlockchainId: track.blockchainId
        }
      })
      const copyFile = await models.File.findOne({
        where: {
          type: 'copy320',
          sourceFile: segmentFile.sourceFile
        }
      })
      if (!copyFile) {
        return successResponse({ isDownloadable: true, cid: null })
      }

      // Asynchronously rehydrate and return CID. If file is not in ipfs, serve from FS
      try {
        // Rehydrate master copy if necessary
        RehydrateIpfsQueue.addRehydrateIpfsFromFsIfNecessaryTask(
          copyFile.multihash,
          copyFile.storagePath,
          { logContext: req.logContext }
        )

        return successResponse({
          isDownloadable: true,
          cid: copyFile.multihash
        })
      } catch (e) {
        return successResponse({ isDownloadable: true, cid: null })
      }
    })
  )

  /**
   * Gets a streamable mp3 link for a track by encodedId. Supports range request headers.
   * @dev - Wrapper around getCID, which retrieves track given its CID.
   **/
  app.get(
    '/tracks/stream/:encodedId',
    async (req, res, next) => {
      const libs = req.app.get('audiusLibs')
      const redisClient = req.app.get('redisClient')
      const delegateOwnerWallet = config.get('delegateOwnerWallet')

      const encodedId = req.params.encodedId
      if (!encodedId) {
        return sendResponse(
          req,
          res,
          errorResponseBadRequest('Please provide a track ID')
        )
      }

      const blockchainId = decode(encodedId)
      if (!blockchainId) {
        return sendResponse(
          req,
          res,
          errorResponseBadRequest(`Invalid ID: ${encodedId}`)
        )
      }

      const isNotServable = await BlacklistManager.trackIdIsInBlacklist(
        blockchainId
      )
      if (isNotServable) {
        return sendResponse(
          req,
          res,
          errorResponseForbidden(
            `trackId=${blockchainId} cannot be served by this node`
          )
        )
      }

      let fileRecord = await models.File.findOne({
        attributes: ['multihash'],
        where: {
          type: 'copy320',
          trackBlockchainId: blockchainId
        },
        order: [['clock', 'DESC']]
      })

      if (!fileRecord) {
        try {
          // see if there's a fileRecord in redis so we can short circuit all this logic
          let redisFileRecord = await redisClient.get(
            `streamFallback:::${blockchainId}`
          )
          if (redisFileRecord) {
            redisFileRecord = JSON.parse(redisFileRecord)
            if (redisFileRecord && redisFileRecord.multihash) {
              fileRecord = redisFileRecord
            }
          }
        } catch (e) {
          req.logger.error(
            { error: e },
            'Error looking for stream fallback in redis'
          )
        }
      }

      // if track didn't finish the upload process and was never associated, there may not be a trackBlockchainId for the File records,
      // try to fall back to discovery to fetch the metadata multihash and see if you can deduce the copy320 file
      if (!fileRecord) {
        try {
          let trackRecord = await libs.Track.getTracks(1, 0, [blockchainId])
          if (
            !trackRecord ||
            trackRecord.length === 0 ||
            !trackRecord[0].hasOwnProperty('blocknumber')
          ) {
            return sendResponse(
              req,
              res,
              errorResponseServerError(
                'Missing or malformatted track fetched from discovery node.'
              )
            )
          }

          trackRecord = trackRecord[0]

          // query the files table for a metadata multihash from discovery for a given track
          // no need to add CNodeUserUUID to the filter because the track is associated with a user and that contains the
          // user_id inside it which is unique to the user
          const file = await models.File.findOne({
            where: {
              multihash: trackRecord.metadata_multihash,
              type: 'metadata'
            }
          })
          if (!file) {
            return sendResponse(
              req,
              res,
              errorResponseServerError(
                'Missing or malformatted track fetched from discovery node.'
              )
            )
          }

          // make sure all track segments have the same sourceFile
          const segments = trackRecord.track_segments.map(
            (segment) => segment.multihash
          )

          const fileSegmentRecords = await models.File.findAll({
            attributes: ['sourceFile'],
            where: {
              multihash: segments,
              cnodeUserUUID: file.cnodeUserUUID
            },
            raw: true
          })

          // check that the number of files in the Files table for these segments for this user matches the number of segments from the metadata object
          if (fileSegmentRecords.length !== trackRecord.track_segments.length) {
            req.logger.warn(
              `Track stream content mismatch for blockchainId ${blockchainId} - number of segments don't match between local and discovery`
            )
          }

          // check that there's a single sourceFile that all File records share by getting an array of uniques
          const uniqSourceFiles = fileSegmentRecords
            .map((record) => record.sourceFile)
            .filter((v, i, a) => a.indexOf(v) === i)

          if (uniqSourceFiles.length !== 1) {
            req.logger.warn(
              `Track stream content mismatch for blockchainId ${blockchainId} - there's not one sourceFile that matches all segments`
            )
          }

          // search for the copy320 record based on the sourceFile
          fileRecord = await models.File.findOne({
            attributes: ['multihash'],
            where: {
              type: 'copy320',
              sourceFile: uniqSourceFiles[0]
            },
            raw: true
          })

          // cache the fileRecord in redis for an hour so we don't have to keep making requests to discovery
          if (fileRecord) {
            redisClient.set(
              `streamFallback:::${blockchainId}`,
              JSON.stringify(fileRecord),
              'EX',
              60 * 60
            )
          }
        } catch (e) {
          req.logger.error(
            { error: e },
            `Error falling back to reconstructing data from discovery to stream`
          )
        }
      }

      if (!fileRecord || !fileRecord.multihash) {
        return sendResponse(
          req,
          res,
          errorResponseBadRequest(
            `No file found for blockchainId ${blockchainId}`
          )
        )
      }

      if (libs.identityService) {
        req.logger.info(
          `Logging listen for track ${blockchainId} by ${delegateOwnerWallet}`
        )
        const signatureData = generateListenTimestampAndSignature(
          config.get('delegatePrivateKey')
        )
        // Fire and forget listen recording
        // TODO: Consider queueing these requests
        libs.identityService.logTrackListen(
          blockchainId,
          delegateOwnerWallet,
          req.ip,
          signatureData
        )
      }

      req.params.CID = fileRecord.multihash
      req.params.streamable = true
      res.set('Content-Type', 'audio/mpeg')
      next()
    },
    getCID
  )

  /**
   * List all unlisted tracks for a user
   */
  app.get(
    '/tracks/unlisted',
    authMiddleware,
    handleResponse(async (req, res) => {
      const tracks = (
        await models.sequelize.query(
          `select "metadataJSON"->'title' as "title", "blockchainId" from (
        select "metadataJSON", "blockchainId", row_number() over (
          partition by "blockchainId" order by "clock" desc
        ) from "Tracks"
        where "cnodeUserUUID" = :cnodeUserUUID
        and ("metadataJSON"->>'is_unlisted')::boolean = true
      ) as a
      where a.row_number = 1;`,
          {
            replacements: { cnodeUserUUID: req.session.cnodeUserUUID }
          }
        )
      )[0]

      return successResponse({
        tracks: tracks.map((track) => ({
          title: track.title,
          id: track.blockchainId
        }))
      })
    })
  )
}
