const addresses = require('../migrations/migration-output.json')
const tokenAddress = addresses.tokenAddress
const registryAddress = addresses.registryAddress
const account = process.env.ACCOUNT || '0xe426ad6DDF3905de9D798f49cb19d6E9A6a3335f'
const tenderizer = process.env.TENDERIZER || '0x36b58F5C1969B7b6591D752ea6F5486D069010AB'

const AudiusToken = artifacts.require('AudiusToken')
const Registry = artifacts.require('Registry')
const DelegateManager = artifacts.require('DelegateManager')
const ClaimsManager = artifacts.require('ClaimsManager')

async function checkStake() {
    const audiusToken = await AudiusToken.at(tokenAddress)
    const registry = await Registry.at(registryAddress)
    const dmAddress = await registry.getContract(web3.utils.fromAscii('DelegateManager'))
    const dm = await DelegateManager.at(dmAddress)
    console.log('Tenderizer Stake =', (await dm.getTotalDelegatorStake(tenderizer)).toString())
}

async function rewards() {
    const registry = await Registry.at(registryAddress)
    const cmAddres = await registry.getContract(web3.utils.fromAscii('ClaimsManagerProxy'))
    const cm = await ClaimsManager.at(cmAddres)

    await cm.initiateRound({ from: account })
    // let tx = await dm.claimRewards(account, { from: account })
}

module.exports = async function(callback) {
  try {
    await checkStake()
    await rewards()
    await checkStake()
  } catch (e) {
    // truffle exec <script> doesn't throw errors, so handling it in a verbose manner here
    console.log(e)
  }
  callback()
}