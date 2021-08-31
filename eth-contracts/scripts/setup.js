const {promisify} = require("es6-promisify");
const addresses = require('../migrations/migration-output.json')
const tokenAddress = addresses.tokenAddress
const registryAddress = addresses.registryAddress
const account = process.env.ACCOUNT || '0x71be63f3384f5fb98995898a86b02fb2426c5788'

const AudiusToken = artifacts.require('AudiusToken')
const Staking = artifacts.require('Staking')
const Registry = artifacts.require('Registry')
const ServiceProviderFactory = artifacts.require('ServiceProviderFactory')
const DelegateManager = artifacts.require('DelegateManager')
const ClaimsManager = artifacts.require('ClaimsManager')

async function setup() {
  const audiusToken = await AudiusToken.at(tokenAddress)
  const registry = await Registry.at(registryAddress)
  const spfAddress = await registry.getContract(web3.utils.fromAscii('ServiceProviderFactory'))
  const cmAddres = await registry.getContract(web3.utils.fromAscii('ClaimsManagerProxy'))
  const stakingAddress =  await registry.getContract(web3.utils.fromAscii('StakingProxy'))
  const spf = await ServiceProviderFactory.at(spfAddress)
  const cm = await ClaimsManager.at(cmAddres)
  
  const serviceType = web3.utils.utf8ToHex('discovery-provider')
  const dummyEndpoint = 'http://testxyz.com'
  const amount = web3.utils.toWei('1000000')
  await audiusToken.approve(stakingAddress, amount,  { from: account })
//   await cm.initiateRound({ from: account })
  await spf.register(serviceType, dummyEndpoint, amount, account,  { from: account })
  console.log('AUDIO.balanceOf', (await audiusToken.balanceOf(account)).toString())
}

async function delegate() {
    const audiusToken = await AudiusToken.at(tokenAddress)
    const registry = await Registry.at(registryAddress)
    const stakingAddress =  await registry.getContract(web3.utils.fromAscii('StakingProxy'))
    const dmAddress = await registry.getContract(web3.utils.fromAscii('DelegateManager'))
    const dm = await DelegateManager.at(dmAddress)
    
    const amount = web3.utils.toWei('10000')
    await audiusToken.approve(stakingAddress, amount,  { from: account })
    let tx = await dm.delegateStake(account, amount,  { from: account })
    console.log('Total Stake =', (await dm.getTotalDelegatorStake(account)).toString())
    console.log('Delegated Stake !! AUDIO.balanceOf =', (await audiusToken.balanceOf(account)).toString())
}

async function checkStake() {
    const audiusToken = await AudiusToken.at(tokenAddress)
    const registry = await Registry.at(registryAddress)
    const dmAddress = await registry.getContract(web3.utils.fromAscii('DelegateManager'))
    const dm = await DelegateManager.at(dmAddress)
    console.log('Total Stake =', (await dm.getTotalDelegatorStake(account)).toString())
    console.log('Delegated Stake !! AUDIO.balanceOf =', (await audiusToken.balanceOf(account)).toString())
}

async function rewards() {
    const audiusToken = await AudiusToken.at(tokenAddress)
    const registry = await Registry.at(registryAddress)
    const dmAddress = await registry.getContract(web3.utils.fromAscii('DelegateManager'))
    const spfAddress = await registry.getContract(web3.utils.fromAscii('ServiceProviderFactory'))
    const cmAddres = await registry.getContract(web3.utils.fromAscii('ClaimsManagerProxy'))
    const dm = await DelegateManager.at(dmAddress)
    const spf = await ServiceProviderFactory.at(spfAddress)
    const cm = await ClaimsManager.at(cmAddres)
    // console.log (JSON.stringify(await spf.getServiceProviderDetails(account)))
    // console.log (JSON.stringify(await spf.getServiceProviderDeployerCutBase()))
    await cm.initiateRound({ from: account })
    let tx = await dm.claimRewards(account, { from: account })
    await tx.wait()
    console.log('Delegated Stake !! AUDIO.balanceOf =', (await audiusToken.balanceOf(account)).toString())
}

module.exports = async function(callback) {
  try {
    // await setup()
    // await delegate()
    await checkStake()
    await rewards()
    await checkStake()
  } catch (e) {
    // truffle exec <script> doesn't throw errors, so handling it in a verbose manner here
    console.log(e)
  }
  callback()
}