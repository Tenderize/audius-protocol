const addresses = require('../migrations/migration-output.json')
const tokenAddress = addresses.tokenAddress
const registryAddress = addresses.registryAddress
const account = process.env.ACCOUNT || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const tenderizer = process.env.TENDERIZER || '0x0355B7B8cb128fA5692729Ab3AAa199C1753f726'

const AudiusToken = artifacts.require('AudiusToken')
const Staking = artifacts.require('Staking')
const Registry = artifacts.require('Registry')
const ServiceProviderFactory = artifacts.require('ServiceProviderFactory')
const DelegateManager = artifacts.require('DelegateManager')
const ClaimsManager = artifacts.require('ClaimsManager')

async function checkStake() {
    const audiusToken = await AudiusToken.at(tokenAddress)
    const registry = await Registry.at(registryAddress)
    const dmAddress = await registry.getContract(web3.utils.fromAscii('DelegateManager'))
    const dm = await DelegateManager.at(dmAddress)
    console.log('Total Stake =', (await dm.getTotalDelegatorStake(tenderizer)).toString())
    console.log('AUDIO.balanceOf(tenderizer) =', (await audiusToken.balanceOf(tenderizer)).toString())
}

async function rewards() {
    const audiusToken = await AudiusToken.at(tokenAddress)
    const registry = await Registry.at(registryAddress)
    const dmAddress = await registry.getContract(web3.utils.fromAscii('DelegateManager'))
    const spfAddress = await registry.getContract(web3.utils.fromAscii('ServiceProviderFactory'))
    const cmAddres = await registry.getContract(web3.utils.fromAscii('ClaimsManagerProxy'))
    const stakingAddress =  await registry.getContract(web3.utils.fromAscii('StakingProxy'))
    const dm = await DelegateManager.at(dmAddress)
    const spf = await ServiceProviderFactory.at(spfAddress)
    const cm = await ClaimsManager.at(cmAddres)

    // const serviceType = web3.utils.utf8ToHex('discovery-provider')
    // let random = (Math.random() + 1).toString(36).substring(7);
    // const dummyEndpoint = `http://${random}.com`
    // const amount = web3.utils.toWei('0.001')
    // await audiusToken.approve(stakingAddress, amount,  { from: account })
    // await spf.register(serviceType, dummyEndpoint, amount, account,  { from: account })
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