"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const AWS = require("aws-sdk");
const axios = require("axios");

/**
 * AWS region in which your User Pools are deployed
 */
const OLD_USER_POOL_REGION = process.env.OLD_USER_POOL_REGION || process.env.AWS_REGION;
/**
 * ID of the old User Pool from which you want to migrate users
 */
const OLD_USER_POOL_ID = process.env.OLD_USER_POOL_ID || '<OLD_USER_POOL_ID>';
/**
 * Client ID in the old User Pool from which you want to migrate users.
 */
const OLD_CLIENT_ID = process.env.OLD_CLIENT_ID || '<OLD_CLIENT_ID>';
const OLD_ROLE_ARN = process.env.OLD_ROLE_ARN;
const OLD_EXTERNAL_ID = process.env.OLD_EXTERNAL_ID;

const NEW_USER_POOL_ID = process.env.NEW_USER_POOL_ID;
const CLOUD_FRONT_URL = process.env.CLOUD_FRONT_URL;

const cognito = new AWS.CognitoIdentityServiceProvider();
async function authenticateUser(cognitoISP, username, password) {
    console.log(`authenticateUser: user='${username}'`);
    try {
        const params = {
            AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
            AuthParameters: {
                PASSWORD: password,
                USERNAME: username,
            },
            ClientId: OLD_CLIENT_ID,
            UserPoolId: OLD_USER_POOL_ID,
        };
        const cognitoResponse = await cognitoISP.adminInitiateAuth(params).promise();
        console.log(`authenticateUser: found ${JSON.stringify(cognitoResponse)}`);
        return lookupUser(cognitoISP, username);
    }
    catch (err) {
        console.log(`authenticateUser: error ${JSON.stringify(err)}`);
        return undefined;
    }
}
async function lookupUser(cognitoISP, username) {
    console.log(`lookupUser: user='${username}'`);
    try {
        const params = {
            UserPoolId: OLD_USER_POOL_ID,
            Username: username,
        };
        const cognitoResponse = await cognitoISP.adminGetUser(params).promise();
        console.log(`lookupUser: found ${JSON.stringify(cognitoResponse)}`);
        const userAttributes = cognitoResponse.UserAttributes ? cognitoResponse.UserAttributes.reduce((acc, entry) => (Object.assign(Object.assign({}, acc), { [entry.Name]: entry.Value })), {}) : {};
        const user = {
            userAttributes,
            userName: cognitoResponse.Username,
        };
        console.log(`lookupUser: response ${JSON.stringify(user)}`);
        return user;
    }
    catch (err) {
        console.log(`lookupUser: error ${JSON.stringify(err)}`);
        return undefined;
    }
}
async function onUserMigrationAuthentication(cognitoISP, event) {
    // authenticate the user with your existing user directory service
    const user = await authenticateUser(cognitoISP, event.userName, event.request.password);
    if (!user) {
        throw new Error('Bad credentials');
    }
    event.response.userAttributes = {
        // old_username: user.userName,
        // 'custom:tenant': user.userAttributes['custom:tenant'],
        email: user.userAttributes.email,
        email_verified: 'true',
        preferred_username: user.userAttributes.preferred_username,
    };
    event.response.finalUserStatus = 'CONFIRMED';
    event.response.messageAction = 'SUPPRESS';
    console.log(`Authentication - response: ${JSON.stringify(event.response)}`);
    await updateUsernameInDatabse(event.userName);
    return event;
}
async function onUserMigrationForgotPassword(cognitoISP, event) {
    // Lookup the user in your existing user directory service
    const user = await lookupUser(cognitoISP, event.userName);
    if (!user) {
        throw new Error('Bad credentials');
    }
    event.response.userAttributes = {
        // old_username: user.userName,
        // 'custom:tenant': user.userAttributes['custom:tenant'],
        email: user.userAttributes.email,
        email_verified: 'true',
        preferred_username: user.userAttributes.preferred_username,
    };
    event.response.messageAction = 'SUPPRESS';
    console.log(`Forgot password - response: ${JSON.stringify(event.response)}`);
    return event;
}

async function getUserFromCurrentUserPool({ username }) {
    const params = {
        UserPoolId: NEW_USER_POOL_ID,
        Username: username, // Assuming the email address is unique and serves as the username
    };
    try {
        const response = await cognito.adminGetUser(params).promise();
        console.log('User retrieved:', response);
        return response;
    } catch (error) {
        console.error('Error retrieving user:', error);
    }
  };
async function updateUsernameInDatabse(email) {
    const clientId = await getUserFromCurrentUserPool({ username: email});
    if (!clientId) {
        throw new Error('getUserFromCurrentUserPool function failed!')
    }
    await axios({
        url: CLOUD_FRONT_URL,
        method: "post",
        data: {
          query: `
                mutation UpdateNewCognitoUserName($email: String!, $username: String!) {
                    updateNewCognitoUserName(email: $email, username: $username)
                }
            `,
          variables: {
            email: email,
            username: clientId,
          },
        },
      }).then((response) => {
        console.log(`Update New congito Username : ${response.data}`);
      }).catch((err) => {
        console.log(`Error while updating username in cognito : ${err}`)
      });
}
exports.handler = async (event, context) => {
    const options = {
        region: OLD_USER_POOL_REGION,
    };
    if (OLD_ROLE_ARN) {
        options.credentials = new AWS.ChainableTemporaryCredentials({
            params: {
                ExternalId: OLD_EXTERNAL_ID,
                RoleArn: OLD_ROLE_ARN,
                RoleSessionName: context.awsRequestId,
            },
        });
    }
    const cognitoIdentityServiceProvider = new AWS.CognitoIdentityServiceProvider(options);
    switch (event.triggerSource) {
        case 'UserMigration_Authentication':
            return onUserMigrationAuthentication(cognitoIdentityServiceProvider, event);
        case 'UserMigration_ForgotPassword':
            return onUserMigrationForgotPassword(cognitoIdentityServiceProvider, event);
        default:
            throw new Error(`Bad triggerSource ${event.triggerSource}`);
    }
};
