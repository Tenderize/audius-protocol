const axios = require('axios')

class SlackReporter {
  constructor ({
    slackUrl,
    childLogger
  }) {
    this.slackUrl = slackUrl
    this.childLogger = childLogger
  }

  getJsonSlackMessage (obj) {
    return `\`\`\`
Source: Identity
${Object.entries(obj).map(([key, value]) => `${key}: ${value}`).join('\n')}
\`\`\``
  }

  async postToSlack ({
    message
  }) {
    try {
      if (!this.slackUrl) return
      await axios.post(this.slackUrl, { text: message })
    } catch (e) {
      this.childLogger.info(`Error posting to slack in slack reporter ${e.toString()}`)
    }
  }
}

class RewardsReporter {
  constructor ({
    successSlackUrl,
    errorSlackUrl,
    childLogger
  }) {
    this.successReporter = new SlackReporter({ slackUrl: successSlackUrl, childLogger })
    this.errorReporter = new SlackReporter({ slackUrl: errorSlackUrl, childLogger })
    this.childLogger = childLogger
  }

  async reportSuccess ({ userId, challengeId, amount }) {
    const report = {
      status: 'success',
      userId,
      challengeId,
      amount: amount.toString()
    }
    const slackMessage = this.successReporter.getJsonSlackMessage(report)
    await this.successReporter.postToSlack({ message: slackMessage })
    this.childLogger.info(report, `Rewards Reporter`)
  }

  async reportFailure ({ userId, challengeId, amount, error, phase }) {
    const report = {
      status: 'failure',
      userId,
      challengeId,
      amount: amount.toString(),
      error: error.toString(),
      phase
    }
    const slackMessage = this.errorReporter.getJsonSlackMessage(report)
    await this.errorReporter.postToSlack({ message: slackMessage })
    this.childLogger.info(report, `Rewards Reporter`)
  }

  async reportAAORejection ({ userId, challengeId, amount, error }) {
    const report = {
      status: 'rejection',
      userId,
      challengeId,
      amount: amount.toString(),
      error: error.toString()
    }
    const slackMessage = this.errorReporter.getJsonSlackMessage(report)
    await this.errorReporter.postToSlack({ message: slackMessage })
    this.childLogger.info(report, `Rewards Reporter`)
  }
}

module.exports = {
  SlackReporter,
  RewardsReporter
}
