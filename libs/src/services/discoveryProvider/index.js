const axios = require('axios')

const Utils = require('../../utils')

const {
  UNHEALTHY_BLOCK_DIFF,
  REQUEST_TIMEOUT_MS
} = require('./constants')

const Requests = require('./requests')

// TODO - webpack workaround. find a way to do this without checkout for .default property
let urlJoin = require('proper-url-join')
const DiscoveryProviderSelection = require('./DiscoveryProviderSelection')
if (urlJoin && urlJoin.default) urlJoin = urlJoin.default

const MAX_MAKE_REQUEST_RETRY_COUNT = 5
const MAX_MAKE_REQUEST_RETRIES_WITH_404 = 2

/**
 * Constructs a service class for a discovery node
 * @param {Set<string>?} whitelist whether or not to only include specified nodes in selection
 * @param {UserStateManager} userStateManager singleton UserStateManager instance
 * @param {EthContracts} ethContracts singleton EthContracts instance
 * @param {number?} reselectTimeout timeout to clear locally cached discovery providers
 * @param {function} selectionCallback invoked when a discovery node is selected
 * @param {object?} monitoringCallbacks callbacks to be invoked with metrics from requests sent to a service
 *  @param {function} monitoringCallbacks.request
 *  @param {function} monitoringCallbacks.healthCheck
 * @param {number?} selectionRequestTimeout the amount of time (ms) an individual request should take before reselecting
 * @param {number?} selectionRequestRetries the number of retries to a given discovery node we make before reselecting
 * @param {number?} unhealthySlotDiffPlays the number of slots we would consider a discovery node unhealthy
 */
class DiscoveryProvider {
  constructor (
    whitelist,
    blacklist,
    userStateManager,
    ethContracts,
    web3Manager,
    reselectTimeout,
    selectionCallback,
    monitoringCallbacks = {},
    selectionRequestTimeout,
    selectionRequestRetries,
    unhealthySlotDiffPlays
  ) {
    this.whitelist = whitelist
    this.blacklist = blacklist
    this.userStateManager = userStateManager
    this.ethContracts = ethContracts
    this.web3Manager = web3Manager

    this.serviceSelector = new DiscoveryProviderSelection({
      whitelist: this.whitelist,
      blacklist: this.blacklist,
      reselectTimeout,
      selectionCallback,
      monitoringCallbacks,
      requestTimeout: selectionRequestTimeout,
      unhealthySlotDiffPlays: unhealthySlotDiffPlays
    }, this.ethContracts)
    this.selectionRequestTimeout = selectionRequestTimeout || REQUEST_TIMEOUT_MS
    this.selectionRequestRetries = selectionRequestRetries || MAX_MAKE_REQUEST_RETRY_COUNT
    this.unhealthySlotDiffPlays = unhealthySlotDiffPlays

    // Keep track of the number of times a request 404s so we know when a true 404 occurs
    // Due to incident where some discovery nodes may erroneously be missing content #flare-51,
    // we treat 404s differently than generic 4xx's or other 5xx errors.
    // In the case of a 404, try a few other nodes
    this.request404Count = 0
    this.maxRequestsForTrue404 = MAX_MAKE_REQUEST_RETRIES_WITH_404

    this.monitoringCallbacks = monitoringCallbacks
  }

  async init () {
    const endpoint = await this.serviceSelector.select()
    this.setEndpoint(endpoint)

    if (endpoint && this.web3Manager && this.web3Manager.web3) {
      // Set current user if it exists
      const userAccount = await this.getUserAccount(this.web3Manager.getWalletAddress())
      if (userAccount) this.userStateManager.setCurrentUser(userAccount)
    }
  }

  setEndpoint (endpoint) {
    this.discoveryProviderEndpoint = endpoint
  }

  /**
   * Get users with all relevant user data
   * can be filtered by providing an integer array of ids
   * @param {number} limit
   * @param {number} offset
   * @param {Object} idsArray
   * @param {string} walletAddress
   * @param {string} handle
   * @param {Boolean} isCreator null returns all users, true returns creators only, false returns users only
   * @returns {Object} {Array of User metadata Objects}
   * additional metadata fields on user objects:
   *  {Integer} track_count - track count for given user
   *  {Integer} playlist_count - playlist count for given user
   *  {Integer} album_count - album count for given user
   *  {Integer} follower_count - follower count for given user
   *  {Integer} followee_count - followee count for given user
   *  {Integer} repost_count - repost count for given user
   *  {Integer} track_blocknumber - blocknumber of latest track for user
   *  {Boolean} does_current_user_follow - does current user follow given user
   *  {Array} followee_follows - followees of current user that follow given user
   * @example
   * await getUsers()
   * await getUsers(100, 0, [3,2,6]) - Invalid user ids will not be accepted
   */
  async getUsers (limit = 100, offset = 0, idsArray = null, walletAddress = null, handle = null, isCreator = null, minBlockNumber = null) {
    const req = Requests.getUsers(
      limit,
      offset,
      idsArray,
      walletAddress,
      handle,
      isCreator,
      minBlockNumber
    )
    return this._makeRequest(req)
  }

  /**
   * get tracks with all relevant track data
   * can be filtered by providing an integer array of ids
   * @param {number} limit
   * @param {number} offset
   * @param {Object} idsArray
   * @param {number} targetUserId the owner of the tracks being queried
   * @param {string} sort a string of form eg. blocknumber:asc,timestamp:desc describing a sort path
   * @param {number} minBlockNumber The min block number
   * @param {boolean} filterDeleted If set to true, filters the deleted tracks
   * @returns {Object} {Array of track metadata Objects}
   * additional metadata fields on track objects:
   *  {Integer} repost_count - repost count for given track
   *  {Integer} save_count - save count for given track
   *  {Array} followee_reposts - followees of current user that have reposted given track
   *  {Boolean} has_current_user_reposted - has current user reposted given track
   *  {Boolean} has_current_user_saved - has current user saved given track
   * @example
   * await getTracks()
   * await getTracks(100, 0, [3,2,6]) - Invalid track ids will not be accepted
   */
  async getTracks (limit = 100, offset = 0, idsArray = null, targetUserId = null, sort = null, minBlockNumber = null, filterDeleted = null, withUsers = false) {
    const req = Requests.getTracks(
      limit,
      offset,
      idsArray,
      targetUserId,
      sort,
      minBlockNumber,
      filterDeleted,
      withUsers
    )
    return this._makeRequest(req)
  }

  /**
   * Gets a particular track by its creator's handle and the track's URL slug
   * @param {string} handle the handle of the owner of the track
   * @param {string} slug the URL slug of the track, generally the title urlized
   * @returns {Object} the requested track's metadata
   */
  async getTracksByHandleAndSlug (handle, slug) {
    // Note: retries are disabled here because the v1 API response returns a 404 instead
    // of an empty array, which can cause a retry storm.
    // TODO: Rewrite this API with something more effective, change makeRequest to
    // support 404s and not retry & use AudiusAPIClient.
    return this._makeRequest(Requests.getTracksByHandleAndSlug(handle, slug), /* retry */ false)
  }

  /**
   * @typedef {Object} getTracksIdentifier
   * @property {string} handle
   * @property {number} id
   * @property {string} url_title
   */

  /**
   * gets all tracks matching identifiers, including unlisted.
   *
   * @param {getTracksIdentifier[]} identifiers
   * @returns {(Array)} track
   */
  async getTracksIncludingUnlisted (identifiers, withUsers = false) {
    const req = Requests.getTracksIncludingUnlisted(
      identifiers,
      withUsers
    )
    return this._makeRequest(req)
  }

  /**
   * Gets random tracks from trending tracks for a given genre.
   * If genre not given, will return trending tracks across all genres.
   * Excludes specified track ids.
   *
   * @param {string} genre
   * @param {number} limit
   * @param {number[]} exclusionList
   * @param {string} time
   * @returns {(Array)} track
   */
  async getRandomTracks (genre, limit, exclusionList, time) {
    const req = Requests.getRandomTracks(genre, limit, exclusionList, time)
    return this._makeRequest(req)
  }

  /**
   * Gets all stems for a given trackId as an array of tracks.
   * @param {number} trackId
   * @returns {(Array)} track
   */
  async getStemsForTrack (trackId) {
    const req = Requests.getStemsForTrack(trackId)
    return this._makeRequest(req)
  }

  /**
   * Gets all the remixes of a given trackId as an array of tracks.
   * @param {number} trackId
   * @param {number} limit
   * @param {number} offset
   * @returns {(Array)} track
   */
  async getRemixesOfTrack (trackId, limit = null, offset = null) {
    const req = Requests.getRemixesOfTrack(trackId, limit, offset)
    return this._makeRequest(req)
  }

  /**
   * Gets the remix parents of a given trackId as an array of tracks.
   * @param {number} limit
   * @param {number} offset
   * @returns {(Array)} track
   */
  async getRemixTrackParents (trackId, limit = null, offset = null) {
    const req = Requests.getRemixTrackParents(trackId, limit, offset)
    return this._makeRequest(req)
  }

  /**
   * Gets tracks trending on Audius.
   * @param {string} genre
   * @param {string} timeFrame one of day, week, month, or year
   * @param {?Array<number>} idsArray track ids
   * @param {?number} limit
   * @param {?number} offset
   * @returns {{listenCounts: Array<{trackId:number, listens:number}>}}
   */
  async getTrendingTracks (genre = null, timeFrame = null, idsArray = null, limit = null, offset = null, withUsers = false) {
    const req = Requests.getTrendingTracks(genre, timeFrame, idsArray, limit, offset, withUsers)
    return this._makeRequest(req)
  }

  /**
   * get full playlist objects, including tracks, for passed in array of playlistId
   * @param {Array} playlistId list of playlist ids
   * @param {number} targetUserId the user whose playlists we're trying to get
   * @param {boolean} withUsers whether to return users nested within the collection objects
   * @returns {Array} array of playlist objects
   * additional metadata fields on playlist objects:
   *  {Integer} repost_count - repost count for given playlist
   *  {Integer} save_count - save count for given playlist
   *  {Boolean} has_current_user_reposted - has current user reposted given playlist
   *  {Array} followee_reposts - followees of current user that have reposted given playlist
   *  {Boolean} has_current_user_reposted - has current user reposted given playlist
   *  {Boolean} has_current_user_saved - has current user saved given playlist
   */
  async getPlaylists (limit = 100, offset = 0, idsArray = null, targetUserId = null, withUsers = false) {
    const req = Requests.getPlaylists(limit, offset, idsArray, targetUserId, withUsers)
    return this._makeRequest(req)
  }

  /**
   * Return social feed for current user
   * @param {filter} string - filter by "all", "original", or "repost"
   * @param {number} limit - max # of items to return
   * @param {number} offset - offset into list to return from (for pagination)
   * @returns {Object} {Array of track and playlist metadata objects}
   * additional metadata fields on track and playlist objects:
   *  {String} activity_timestamp - timestamp of requested user's repost for given track or playlist,
   *    used for sorting feed
   *  {Integer} repost_count - repost count of given track/playlist
   *  {Integer} save_count - save count of given track/playlist
   *  {Boolean} has_current_user_reposted - has current user reposted given track/playlist
   *  {Array} followee_reposts - followees of current user that have reposted given track/playlist
   */
  async getSocialFeed (filter, limit = 100, offset = 0, withUsers = false, tracksOnly = false) {
    const req = Requests.getSocialFeed(filter, limit, offset, withUsers, tracksOnly)
    return this._makeRequest(req)
  }

  /**
   * Return repost feed for requested user
   * @param {number} userId - requested user id
   * @param {filter} string - filter by "all", "original", or "repost"
   * @param {number} limit - max # of items to return (for pagination)
   * @param {number} offset - offset into list to return from (for pagination)
   * @returns {Object} {Array of track and playlist metadata objects}
   * additional metadata fields on track and playlist objects:
   *  {String} activity_timestamp - timestamp of requested user's repost for given track or playlist,
   *    used for sorting feed
   *  {Integer} repost_count - repost count of given track/playlist
   *  {Integer} save_count - save count of given track/playlist
   *  {Boolean} has_current_user_reposted - has current user reposted given track/playlist
   *  {Array} followee_reposts - followees of current user that have reposted given track/playlist
   */
  async getUserRepostFeed (userId, limit = 100, offset = 0, withUsers = false) {
    const req = Requests.getUserRepostFeed(userId, limit, offset, withUsers)
    return this._makeRequest(req)
  }

  /**
   * get intersection of users that follow followeeUserId and users that are followed by followerUserId
   * @param {number} followeeUserId user that is followed
   * @param {number} followerUserId user that follows
   * @example
   * getFollowIntersectionUsers(100, 0, 1, 1) - IDs must be valid
   */
  async getFollowIntersectionUsers (limit = 100, offset = 0, followeeUserId, followerUserId) {
    const req = Requests.getFollowIntersectionUsers(limit, offset, followeeUserId, followerUserId)
    return this._makeRequest(req)
  }

  /**
   * get intersection of users that have reposted repostTrackId and users that are followed by followerUserId
   * followee = user that is followed; follower = user that follows
   * @param {number} repostTrackId track that is reposted
   * @param {number} followerUserId user that reposted track
   * @example
   * getTrackRepostIntersectionUsers(100, 0, 1, 1) - IDs must be valid
   */
  async getTrackRepostIntersectionUsers (limit = 100, offset = 0, repostTrackId, followerUserId) {
    const req = Requests.getTrackRepostIntersectionUsers(limit = 100, offset = 0, repostTrackId, followerUserId)
    return this._makeRequest(req)
  }

  /**
   * get intersection of users that have reposted repostPlaylistId and users that are followed by followerUserId
   * followee = user that is followed; follower = user that follows
   * @param {number} repostPlaylistId playlist that is reposted
   * @param {number} followerUserId user that reposted track
   * @example
   * getPlaylistRepostIntersectionUsers(100, 0, 1, 1) - IDs must be valid
   */
  async getPlaylistRepostIntersectionUsers (limit = 100, offset = 0, repostPlaylistId, followerUserId) {
    const req = Requests.getPlaylistRepostIntersectionUsers(limit, offset, repostPlaylistId, followerUserId)
    return this._makeRequest(req)
  }

  /**
   * get users that follow followeeUserId, sorted by follower count descending
   * @param {number} followeeUserId user that is followed
   * @return {Array} array of user objects with standard user metadata
   */
  async getFollowersForUser (limit = 100, offset = 0, followeeUserId) {
    const req = Requests.getFollowersForUser(limit, offset, followeeUserId)
    return this._makeRequest(req)
  }

  /**
   * get users that are followed by followerUserId, sorted by follower count descending
   * @param {number} followerUserId user - i am the one who follows
   * @return {Array} array of user objects with standard user metadata
   */
  async getFolloweesForUser (limit = 100, offset = 0, followerUserId) {
    const req = Requests.getFolloweesForUser(limit, offset, followerUserId)
    return this._makeRequest(req)
  }

  /**
   * get users that reposted repostTrackId, sorted by follower count descending
   * @param {number} repostTrackId
   * @return {Array} array of user objects
   * additional metadata fields on user objects:
   *  {Integer} follower_count - follower count of given user
   * @example
   * getRepostersForTrack(100, 0, 1) - ID must be valid
   */
  async getRepostersForTrack (limit = 100, offset = 0, repostTrackId) {
    const req = Requests.getRepostersForTrack(limit, offset, repostTrackId)
    return this._makeRequest(req)
  }

  /**
   * get users that reposted repostPlaylistId, sorted by follower count descending
   * @param {number} repostPlaylistId
   * @return {Array} array of user objects
   * additional metadata fields on user objects:
   *  {Integer} follower_count - follower count of given user
   * @example
   * getRepostersForPlaylist(100, 0, 1) - ID must be valid
   */
  async getRepostersForPlaylist (limit = 100, offset = 0, repostPlaylistId) {
    const req = Requests.getRepostersForPlaylist(limit, offset, repostPlaylistId)
    return this._makeRequest(req)
  }

  /**
   * get users that saved saveTrackId, sorted by follower count descending
   * @param {number} saveTrackId
   * @return {Array} array of user objects
   * additional metadata fields on user objects:
   *  {Integer} follower_count - follower count of given user
   * @example
   * getSaversForTrack(100, 0, 1) - ID must be valid
   */
  async getSaversForTrack (limit = 100, offset = 0, saveTrackId) {
    const req = Requests.getSaversForTrack(limit, offset, saveTrackId)
    return this._makeRequest(req)
  }

  /**
   * get users that saved savePlaylistId, sorted by follower count descending
   * @param {number} savePlaylistId
   * @return {Array} array of user objects
   * additional metadata fields on user objects:
   *  {Integer} follower_count - follower count of given user
   * @example
   * getSaversForPlaylist(100, 0, 1) - ID must be valid
   */
  async getSaversForPlaylist (limit = 100, offset = 0, savePlaylistId) {
    const req = Requests.getSaversForPlaylist(limit, offset, savePlaylistId)
    return this._makeRequest(req)
  }

  /**
   * Perform a full-text search. Returns tracks, users, playlists, albums
   *    with optional user-specific results for each
   *  - user, track, and playlist objects have all same data as returned from standalone endpoints
   * @param {string} text search query
   * @param {string} kind 'tracks', 'users', 'playlists', 'albums', 'all'
   * @param {number} limit max # of items to return per list (for pagination)
   * @param {number} offset offset into list to return from (for pagination)
   */
  async searchFull (text, kind, limit = 100, offset = 0) {
    const req = Requests.searchFull(text, kind, limit, offset)
    return this._makeRequest(req)
  }

  /**
   * Perform a lighter-weight full-text search. Returns tracks, users, playlists, albums
   *    with optional user-specific results for each
   *  - user, track, and playlist objects have core data, and track & playlist objects
   *    also return user object
   * @param {string} text search query
   * @param {number} limit max # of items to return per list (for pagination)
   * @param {number} offset offset into list to return from (for pagination)
   */
  async searchAutocomplete (text, limit = 100, offset = 0) {
    const req = Requests.searchAutocomplete(text, limit, offset)
    return this._makeRequest(req)
  }

  /**
   * Perform a tags-only search. Returns tracks with required tag and users
   * that have used a tag greater than a specified number of times
   * @param {string} text search query
   * @param {number} user_tag_count min # of times a user must have used a tag to be returned
   * @param {string} kind 'tracks', 'users', 'playlists', 'albums', 'all'
   * @param {number} limit max # of items to return per list (for pagination)
   * @param {number} offset offset into list to return from (for pagination)
   */
  async searchTags (text, user_tag_count = 2, kind = 'all', limit = 100, offset = 0) {
    const req = Requests.searchTags(text, user_tag_count, kind, limit, offset)
    return this._makeRequest(req)
  }

  /**
   * Return saved playlists for current user
   * NOTE in returned JSON, SaveType string one of track, playlist, album
   * @param {number} limit - max # of items to return
   * @param {number} offset - offset into list to return from (for pagination)
   */
  async getSavedPlaylists (limit = 100, offset = 0, withUsers = false) {
    const req = Requests.getSavedPlaylists(limit, offset, withUsers)
    return this._makeRequest(req)
  }

  /**
   * Return saved albums for current user
   * NOTE in returned JSON, SaveType string one of track, playlist, album
   * @param {number} limit - max # of items to return
   * @param {number} offset - offset into list to return from (for pagination)
   */
  async getSavedAlbums (limit = 100, offset = 0, withUsers = false) {
    const req = Requests.getSavedAlbums(limit, offset, withUsers)
    return this._makeRequest(req)
  }

  /**
   * Return saved tracks for current user
   * NOTE in returned JSON, SaveType string one of track, playlist, album
   * @param {number} limit - max # of items to return
   * @param {number} offset - offset into list to return from (for pagination)
   */
  async getSavedTracks (limit = 100, offset = 0, withUsers = false) {
    const req = Requests.getSavedTracks(limit, offset, withUsers)
    return this._makeRequest(req)
  }

  /**
   * Return user collections (saved & uploaded) along w/ users for those collections
   */
  async getUserAccount (wallet) {
    const req = Requests.getUserAccount(wallet)
    return this._makeRequest(req)
  }

  async getTopPlaylists (type, limit, mood, filter, withUsers = false) {
    const req = Requests.getTopPlaylists(type, limit, mood, filter, withUsers)
    return this._makeRequest(req)
  }

  async getTopFolloweeWindowed (type, window, limit, withUsers = false) {
    const req = Requests.getTopFolloweeWindowed(type, window, limit, withUsers)
    return this._makeRequest(req)
  }

  async getTopFolloweeSaves (type, limit, withUsers = false) {
    const req = Requests.getTopFolloweeSaves(type, limit, withUsers)
    return this._makeRequest(req)
  }

  async getLatest (type) {
    const req = Requests.getLatest(type)
    return this._makeRequest(req)
  }

  async getTopCreatorsByGenres (genres, limit = 30, offset = 0, withUsers = false) {
    const req = Requests.getTopCreatorsByGenres(genres, limit, offset, withUsers)
    return this._makeRequest(req)
  }

  async getURSMContentNodes (ownerWallet = null) {
    const req = Requests.getURSMContentNodes(ownerWallet)
    return this._makeRequest(req)
  }

  async getNotifications (minBlockNumber, trackIds, timeout) {
    const req = Requests.getNotifications(minBlockNumber, trackIds, timeout)
    return this._makeRequest(req)
  }

  async getSolanaNotifications (minSlotNumber, timeout) {
    const req = Requests.getSolanaNotifications(minSlotNumber, timeout)
    return this._makeRequest(req)
  }

  async getTrackListenMilestones (timeout = null) {
    const req = Requests.getTrackListenMilestones(timeout)
    return this._makeRequest(req)
  }

  async getChallengeAttestation (challengeId, encodedUserId, specifier, oracleAddress, discoveryProviderEndpoint) {
    const req = Requests.getChallengeAttestation(challengeId, encodedUserId, specifier, oracleAddress)
    const { data } = await this._performRequestWithMonitoring(req, discoveryProviderEndpoint)
    return data
  }

  async getCreateSenderAttestation (senderEthAddress, discoveryProviderEndpoint) {
    const req = Requests.getCreateSenderAttestation(senderEthAddress)
    const { data } = await this._performRequestWithMonitoring(req, discoveryProviderEndpoint)
    return data
  }

  async getUndisbursedChallenges (limit = null, offset = null, completedBlockNumber = null, encodedUserId = null) {
    const req = Requests.getUndisbursedChallenges(limit, offset, completedBlockNumber, encodedUserId)
    const res = await this._makeRequest(req)
    if (!res) return []
    return res.map(r => ({ ...r, amount: parseInt(r.amount) }))
  }

  /* ------- INTERNAL FUNCTIONS ------- */

  /**
   * Performs a single request, defined in the request, via axios, calling any
   * monitoring callbacks as needed.
   *
   * @param {{
     endpoint: string,
     urlParams: string,
     queryParams: object,
     method: string,
     headers: object,
   }} requestObj
   * @param {string} discoveryProviderEndpoint
   * @returns
   * @memberof DiscoveryProvider
   */
  async _performRequestWithMonitoring (requestObj, discoveryProviderEndpoint) {
    const axiosRequest = this._createDiscProvRequest(requestObj, discoveryProviderEndpoint)
    let response
    let parsedResponse

    const url = new URL(axiosRequest.url)
    const start = Date.now()
    try {
      response = await axios(axiosRequest)
      const duration = Date.now() - start
      parsedResponse = Utils.parseDataFromResponse(response)

      // Fire monitoring callbacks for request success case
      if (this.monitoringCallbacks.request) {
        try {
          this.monitoringCallbacks.request({
            endpoint: url.origin,
            pathname: url.pathname,
            queryString: url.search,
            signer: response.data.signer,
            signature: response.data.signature,
            requestMethod: axiosRequest.method,
            status: response.status,
            responseTimeMillis: duration
          })
        } catch (e) {
          // Swallow errors -- this method should not throw generally
          console.error(e)
        }
      }
    } catch (e) {
      const resp = e.response || {}
      const duration = Date.now() - start
      const errMsg = e.response && e.response.data ? e.response.data : e

      // Fire monitoring callbaks for request failure case
      if (this.monitoringCallbacks.request) {
        try {
          this.monitoringCallbacks.request({
            endpoint: url.origin,
            pathname: url.pathname,
            queryString: url.search,
            requestMethod: axiosRequest.method,
            status: resp.status,
            responseTimeMillis: duration
          })
        } catch (e) {
          // Swallow errors -- this method should not throw generally
          console.error(e)
        }
      }
      if (resp && resp.status === 404) {
        // We have 404'd. Throw that error message back out
        throw new Error('404')
      }

      throw errMsg
    }
    return parsedResponse
  }

  /**
   * Gets how many blocks behind a discovery node is.
   * If this method throws (missing data in health check response),
   * return an unhealthy number of blocks
   * @param {Object} parsedResponse health check response object
   * @returns {number | null} a number of blocks if behind or null if not behind
   */
  async _getBlocksBehind (parsedResponse) {
    try {
      const {
        latest_indexed_block: indexedBlock,
        latest_chain_block: chainBlock
      } = parsedResponse

      const blockDiff = chainBlock - indexedBlock
      if (blockDiff > UNHEALTHY_BLOCK_DIFF) {
        return blockDiff
      }
      return null
    } catch (e) {
      console.error(e)
      return UNHEALTHY_BLOCK_DIFF
    }
  }

  /**
   * Gets how many plays slots behind a discovery node is.
   * If this method throws (missing data in health check response),
   * return an unhealthy number of slots
   * @param {Object} parsedResponse health check response object
   * @returns {number | null} a number of slots if behind or null if not behind
   */
  async _getPlaysSlotsBehind (parsedResponse) {
    if (!this.unhealthySlotDiffPlays) return null

    try {
      const {
        latest_indexed_slot_plays: indexedSlotPlays,
        latest_chain_slot_plays: chainSlotPlays
      } = parsedResponse

      const slotDiff = chainSlotPlays - indexedSlotPlays
      if (slotDiff > this.unhealthySlotDiffPlays) {
        return slotDiff
      }
      return null
    } catch (e) {
      console.error(e)
      return this.unhealthySlotDiffPlays
    }
  }

  /**
   * Makes a request to a discovery node, reselecting if necessary
   * @param {{
   *  endpoint: string
   *  urlParams: object
   *  queryParams: object
   *  method: string
   *  headers: object
   * }} {
   *  endpoint: the base route
   *  urlParams: string of URL params to be concatenated after base route
   *  queryParams: URL query (search) params
   *  method: string HTTP method
   * }
   * @param {boolean?} retry whether to retry on failure
   * @param {number?} attemptedRetries number of attempted retries (stops retrying at max)
   */
  async _makeRequest (requestObj, retry = true, attemptedRetries = 0) {
    try {
      const newDiscProvEndpoint = await this.getHealthyDiscoveryProviderEndpoint(attemptedRetries)

      // If new DP endpoint is selected, update disc prov endpoint and reset attemptedRetries count
      if (this.discoveryProviderEndpoint !== newDiscProvEndpoint) {
        let updateDiscProvEndpointMsg = `Current Discovery Provider endpoint ${this.discoveryProviderEndpoint} is unhealthy. `
        updateDiscProvEndpointMsg += `Switching over to the new Discovery Provider endpoint ${newDiscProvEndpoint}!`
        console.info(updateDiscProvEndpointMsg)
        this.discoveryProviderEndpoint = newDiscProvEndpoint
        attemptedRetries = 0
      }
    } catch (e) {
      console.error(e)
      return
    }
    let parsedResponse
    try {
      parsedResponse = await this._performRequestWithMonitoring(requestObj, this.discoveryProviderEndpoint)
    } catch (e) {
      const failureStr = `Failed to make Discovery Provider request, `
      const attemptStr = `attempt #${attemptedRetries}, `
      const errorStr = `error ${JSON.stringify(e.message)}, `
      const requestStr = `request: ${JSON.stringify(requestObj)}`
      const fullErrString = `${failureStr}${attemptStr}${errorStr}${requestStr}`

      console.warn(fullErrString)

      if (retry) {
        if (e.message === '404') {
          this.request404Count += 1
          if (this.request404Count < this.maxRequestsForTrue404) {
            // In the case of a 404, retry with a different discovery node entirely
            // using selectionRequestRetries + 1 to force reselection
            return this._makeRequest(requestObj, retry, this.selectionRequestRetries + 1)
          } else {
            this.request404Count = 0
            return null
          }
        }

        // In the case of an unknown error, retry with attempts += 1
        return this._makeRequest(requestObj, retry, attemptedRetries + 1)
      }

      return null
    }

    // Validate health check response

    // Regressed mode signals we couldn't find a node that wasn't behind by some measure
    // so we should should pick something
    const notInRegressedMode = this.ethContracts && !this.ethContracts.isInRegressedMode()

    const blockDiff = await this._getBlocksBehind(parsedResponse)
    if (notInRegressedMode && blockDiff) {
      if (retry) {
        console.info(
          `${this.discoveryProviderEndpoint} is too far behind [block diff: ${blockDiff}]. Retrying request at attempt #${attemptedRetries}...`
        )
        return this._makeRequest(requestObj, retry, attemptedRetries + 1)
      }
      return null
    }

    const playsSlotDiff = await this._getPlaysSlotsBehind(parsedResponse)
    if (notInRegressedMode && playsSlotDiff) {
      if (retry) {
        console.info(
          `${this.discoveryProviderEndpoint} is too far behind [slot diff: ${playsSlotDiff}]. Retrying request at attempt #${attemptedRetries}...`
        )
        return this._makeRequest(requestObj, retry, attemptedRetries + 1)
      }
      return null
    }

    // Reset 404 counts
    this.request404Count = 0

    // Everything looks good, return the data!
    return parsedResponse.data
  }

  /**
   * Gets the healthy discovery provider endpoint used in creating the axios request later.
   * If the number of retries is over the max count for retires, clear the cache and reselect
   * another healthy discovery provider. Else, return the current discovery provider endpoint
   * @param {number} attemptedRetries the number of attempted requests made to the current disc prov endpoint
   */
  async getHealthyDiscoveryProviderEndpoint (attemptedRetries) {
    let endpoint = this.discoveryProviderEndpoint
    if (attemptedRetries > this.selectionRequestRetries) {
      // Add to unhealthy list if current disc prov endpoint has reached max retry count
      console.info(`Attempted max retries with endpoint ${endpoint}`)
      this.serviceSelector.addUnhealthy(endpoint)

      // Clear the cached endpoint and select new endpoint from backups
      this.serviceSelector.clearCached()
      endpoint = await this.serviceSelector.select()
    }

    // If there are no more available backups, throw error
    if (!endpoint) {
      throw new Error('All Discovery Providers are unhealthy and unavailable.')
    }

    return endpoint
  }

  /**
   * Creates the discovery provider axios request object with necessary configs
   * @param {object} requestObj
   * @param {string} discoveryProviderEndpoint
   */
  _createDiscProvRequest (requestObj, discoveryProviderEndpoint) {
    let requestUrl

    // Sanitize URL params if needed
    if (requestObj.queryParams) {
      Object.entries(requestObj.queryParams).forEach(([k, v]) => {
        if (v === undefined || v === null) {
          delete requestObj.queryParams[k]
        }
      })
    }

    if (urlJoin && urlJoin.default) {
      requestUrl = urlJoin.default(discoveryProviderEndpoint, requestObj.endpoint, requestObj.urlParams, { query: requestObj.queryParams })
    } else {
      requestUrl = urlJoin(discoveryProviderEndpoint, requestObj.endpoint, requestObj.urlParams, { query: requestObj.queryParams })
    }

    let headers = {}
    if (requestObj.headers) {
      headers = requestObj.headers
    }
    const currentUserId = this.userStateManager.getCurrentUserId()
    if (currentUserId) {
      headers['X-User-ID'] = currentUserId
    }

    const timeout = requestObj.timeout || this.selectionRequestTimeout
    let axiosRequest = {
      url: requestUrl,
      headers: headers,
      method: (requestObj.method || 'get'),
      timeout
    }

    if (requestObj.method === 'post' && requestObj.data) {
      axiosRequest = {
        ...axiosRequest,
        data: requestObj.data
      }
    }
    return axiosRequest
  }
}

module.exports = DiscoveryProvider
