const _lib = require('../utils/lib')
const addresses = require('../migrations/migration-output.json')
const tokenAddress = addresses.tokenAddress
const registryAddress = addresses.registryAddress
const account = process.env.ACCOUNT || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const AudiusToken = artifacts.require('AudiusToken')
const Staking = artifacts.require('Staking')
const Registry = artifacts.require('Registry')
const ServiceProviderFactory = artifacts.require('ServiceProviderFactory')
const DelegateManager = artifacts.require('DelegateManager')
const ClaimsManager = artifacts.require('ClaimsManager')
const Governance = artifacts.require('Governance')

async function setup() {
    const audiusToken = await AudiusToken.at(tokenAddress)
    const registry = await Registry.at(registryAddress)
    const spfAddress = await registry.getContract(web3.utils.fromAscii('ServiceProviderFactory'))
    const cmKey = web3.utils.fromAscii('ClaimsManagerProxy')
    const cmAddres = await registry.getContract(cmKey)
    const stakingAddress =  await registry.getContract(web3.utils.fromAscii('StakingProxy'))
    const spf = await ServiceProviderFactory.at(spfAddress)
    const cm = await ClaimsManager.at(cmAddres)

    // updateFundingRoundBlockDiff to 0
    const govAddress = await registry.getContract(web3.utils.fromAscii('Governance')) 
    const gov = await Governance.at(govAddress)
    await gov.guardianExecuteTransaction(
        cmKey, 
        _lib.toBN(0),
        'updateFundingRoundBlockDiff(uint256)',
        _lib.abiEncode(['uint256'], [0]),
        { from: account })

    const serviceType = web3.utils.utf8ToHex('creator-node')
    const dummyEndpoint = 'http://testxyz.com'
    const amount = web3.utils.toWei('200000')
    await audiusToken.approve(stakingAddress, amount,  { from: account })
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

async function getAddresses() {
    const registry = await Registry.at(registryAddress)
    console.log('AUDIO Token:', tokenAddress)
    console.log('DelgateManager:', await registry.getContract(web3.utils.fromAscii('DelegateManager')))
    console.log('Account: ', account)
}

module.exports = async function(callback) {
  try {
    await setup()
    // await delegate()
    await getAddresses()
  } catch (e) {
    // truffle exec <script> doesn't throw errors, so handling it in a verbose manner here
    console.log(e)
  }
  callback()
}