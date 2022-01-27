// const {promisify} = require("es6-promisify");
const addresses = require('../migrations/migration-output.json')
const tokenAddress = addresses.tokenAddress
const registryAddress = addresses.registryAddress
const account = process.env.ACCOUNT || '0x71be63f3384f5fb98995898a86b02fb2426c5788'

const Registry = artifacts.require('Registry')

async function getAddresses() {
    const registry = await Registry.at(registryAddress)
    console.log('AUDIO Token:', tokenAddress)
    console.log('DelgateManager:', await registry.getContract(web3.utils.fromAscii('DelegateManager')))
    console.log('Account: ', account)
}

module.exports = async function(callback) {
  try {
    await getAddresses()
  } catch (e) {
    // truffle exec <script> doesn't throw errors, so handling it in a verbose manner here
    console.log(e)
  }
  callback()
}