const bunyan = require('bunyan')
const shortid = require('shortid')

const config = require('./config')

const logLevel = config.get('logLevel') || 'info'
const logger = bunyan.createLogger({
  name: 'audius_creator_node',
  streams: [
    {
      level: logLevel,
      stream: process.stdout
    }
  ]
})
logger.info('Loglevel set to:', logLevel)

/**
 * TODO make this more readable
 */
const excludedRoutes = [
  '/health_check',
  '/ipfs',
  'ipfs_peer_info',
  '/tracks/download_status',
  '/db_check',
  '/version',
  '/disk_check',
  '/sync_status'
]
function requestNotExcludedFromLogging(url) {
  return (
    excludedRoutes.filter((excludedRoute) => url.includes(excludedRoute))
      .length === 0
  )
}

/**
 * @notice request headers are case-insensitive
 */
function getRequestLoggingContext(req, requestID) {
  req.startTime = getStartTime()
  const urlParts = req.url.split('?')
  return {
    requestID,
    requestMethod: req.method,
    requestHostname: req.hostname,
    requestUrl: urlParts[0],
    requestQueryParams: urlParts.length > 1 ? urlParts[1] : undefined,
    requestWallet: req.get('user-wallet-addr'),
    requestBlockchainUserId: req.get('user-id')
  }
}

/**
 * Gets the start time
 * @returns the start time
 */
function getStartTime() {
  return process.hrtime()
}

function loggingMiddleware(req, res, next) {
  const providedRequestID = req.header('X-Request-ID')
  const requestID = providedRequestID || shortid.generate()
  res.set('CN-Request-ID', requestID)

  req.logContext = getRequestLoggingContext(req, requestID)
  req.logger = logger.child(req.logContext)

  if (requestNotExcludedFromLogging(req.originalUrl)) {
    req.logger.info('Begin processing request')
  }
  next()
}

/**
 * Add fields to a child logger instance
 * @param {*} req
 * @param {Object} options fields to add to child logger
 * @returns a logger instance
 */
function setFieldsInChildLogger(req, options = {}) {
  const fields = Object.keys(options)

  const childOptions = {}
  fields.forEach((field) => {
    childOptions[field] = options[field]
  })

  return req.logger.child(childOptions)
}

/**
 * Pulls the start time of the req object to calculate the duration of the fn
 * @param {number} startTime the start time
 * @returns the duration of the fn call in ms
 */
function getDuration({ startTime }) {
  let durationMs
  if (startTime) {
    const endTime = process.hrtime(startTime)
    durationMs = Math.round(endTime[0] * 1e3 + endTime[1] * 1e-6)
  }

  return durationMs
}

/**
 * Prints the log message with the duration
 * @param {Object} logger
 * @param {number} startTime the start time
 * @param {string} msg the message to print
 */
function logInfoWithDuration({ logger, startTime }, msg) {
  const durationMs = getDuration({ startTime })

  if (durationMs) {
    logger.info({ duration: durationMs }, msg)
  } else {
    logger.info(msg)
  }
}

module.exports = {
  logger,
  loggingMiddleware,
  requestNotExcludedFromLogging,
  getRequestLoggingContext,
  getStartTime,
  getDuration,
  setFieldsInChildLogger,
  logInfoWithDuration
}
