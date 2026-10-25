/**
 * Default AWS wiring. The Lambda Node.js 22 runtime ships AWS SDK v3
 * (`@aws-sdk/client-ssm`, `@aws-sdk/client-dynamodb`), so the deployment stays
 * a zip of plain files with no node_modules. Required lazily: tests inject a
 * fake `loadSdk` and never load the SDK.
 *
 * Execution-role permissions this needs (see README → IAM):
 *   ssm:GetParameter                     on parameter/camstack/alexa/*
 *   kms:Decrypt                          on the `aws/ssm` key, only via SSM and
 *                                        only for those parameters (D761)
 *   dynamodb:GetItem/PutItem/DeleteItem  on the tokens table
 */
'use strict'

/**
 * @param {object} [opts]
 * @param {(name: string) => any} [opts.loadSdk]  module loader (tests inject a fake)
 */
function createAwsClients(opts) {
  const loadSdk = (opts && opts.loadSdk) || require
  let ddbClient = null
  let ssmClient = null
  let ssmSdk = null

  async function send(commandName, input) {
    const ddb = loadSdk('@aws-sdk/client-dynamodb')
    if (!ddbClient) ddbClient = new ddb.DynamoDBClient({})
    const Command = ddb[`${commandName}Command`]
    if (typeof Command !== 'function') throw new Error(`unknown DynamoDB command ${commandName}`)
    return ddbClient.send(new Command(input))
  }

  /**
   * The decrypted value of one SecureString parameter. Errors name the
   * parameter, never a value.
   */
  async function readParameter(name) {
    if (!ssmSdk) ssmSdk = loadSdk('@aws-sdk/client-ssm')
    if (!ssmClient) ssmClient = new ssmSdk.SSMClient({})
    const res = await ssmClient.send(
      new ssmSdk.GetParameterCommand({ Name: name, WithDecryption: true }),
    )
    const value = res && res.Parameter ? res.Parameter.Value : undefined
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`parameter ${name} has no value`)
    }
    return value
  }

  return { send, readParameter }
}

module.exports = { createAwsClients }
