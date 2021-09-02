// config values stored by network name. see truffle-config.json for a mapping from network
// name to other params
module.exports = {
  'development': {
    proxyDeployerAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    proxyAdminAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    guardianAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    wormholeAddress: null,
    antiAbuseOracleAddresses: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
    solanaRecipientAddress: null
  },
  'test_local': {
    proxyDeployerAddress: null,
    proxyAdminAddress: null,
    guardianAddress: null,
    wormholeAddress: null,
    antiAbuseOracleAddresses: null,
    solanaRecipientAddress: null
  },
  'soliditycoverage': {
    proxyDeployerAddress: null,
    proxyAdminAddress: null,
    guardianAddress: null,
    wormholeAddress: null,
    antiAbuseOracleAddresses: null,
    solanaRecipientAddress: null
  },
  'audius_private': {
    proxyDeployerAddress: null,
    proxyAdminAddress: null,
    guardianAddress: null,
    wormholeAddress: null,
    antiAbuseOracleAddresses: null,
    solanaRecipientAddress: null
  },
  'staging': {
    proxyDeployerAddress: null,
    proxyAdminAddress: null,
    guardianAddress: null,
    wormholeAddress: null,
    antiAbuseOracleAddresses: null,
    solanaRecipientAddress: null
  },
  'production': {
    proxyDeployerAddress: null,
    proxyAdminAddress: null,
    guardianAddress: null,
    wormholeAddress: null,
    antiAbuseOracleAddresses: null,
    solanaRecipientAddress: null
  },
  'rinkeby': {
    proxyDeployerAddress: '0xe426ad6DDF3905de9D798f49cb19d6E9A6a3335f',
    proxyAdminAddress: '0xe426ad6DDF3905de9D798f49cb19d6E9A6a3335f',
    guardianAddress: '0xe426ad6DDF3905de9D798f49cb19d6E9A6a3335f',
    wormholeAddress: null, // deploy mock
    antiAbuseOracleAddresses: ['0xe426ad6DDF3905de9D798f49cb19d6E9A6a3335f'],
    solanaRecipientAddress: null
  },
}
