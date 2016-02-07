// Port of Geeknote oauth module (https://github.com/VitaliyRodnenko/geeknote/blob/master/geeknote/oauth.py)

import uuid from 'uuid4';
import merge from 'merge';
import prompt from 'prompt';
import cheerio from 'cheerio';
import request from 'request';
import Promise from 'bluebird';
import ProgressBar from 'progress';
import queryString from 'querystring';

const promptGet = Promise.promisify(prompt.get);

const BASE_URL = 'https://www.evernote.com';
const CONSUMER_KEY = 'skaizer-5314';
const CONSUMER_SECRET = '6f4f9183b3120801';

const TOKEN_URI = '/oauth';
const LOGIN_URI = '/Login.action';
const ACCESS_URI = '/OAuth.action';

const CookieJar = request.jar();

export default function getAuthToken() {
	return init()
		.then(notify('Authorize...'))
		.then(getTmpOAuthToken)
		.then(login)
		.then(notify('Allow Access...'))
		.then(allowAccess)
		.then(notify('Getting Token...'))
		.then(getOAuthToken);
}

function init() {
	let ctx = {
		OAuthToken: '',
		tmpOAuthToken: '',
		verifierToken: '',
		incorrectLogin: 0,
	};

	return Promise.resolve(ctx);
}

function updateCtx(ctx, update) {
	return merge({}, ctx, update);
}

function notify(message) {
	return (data) => {
		message && console.log(message);
		return data;
	};
}

function getUserCredentials() {
	prompt.start();

	return promptGet([{
		name: 'username',
		description: 'Login',
		required: true,
		type: 'string',
	}, {
		name: 'password',
		description: 'Password',
		required: true,
		type: 'string',
		hidden: true,
	}]);
}

function getTokenRequestData() {
	return {
		'oauth_consumer_key': CONSUMER_KEY,
		'oauth_signature': `${CONSUMER_SECRET}%26`,
		'oauth_signature_method': 'PLAINTEXT',
		'oauth_timestamp': Date.now(),
		'oauth_nonce': uuid(),
	};
}

function getTmpOAuthToken(ctx) {
	return new Promise((resolve, reject) => {
		let url = `${BASE_URL}${TOKEN_URI}`;
		let qs = merge({'oauth_callback': BASE_URL}, getTokenRequestData());
		let jar = CookieJar;

		request.get({url, jar, qs}, (error, {statusCode}, body) => {
			if (error) return reject(error);

			let {oauth_token: tmpOAuthToken} = queryString.parse(body);

			if (statusCode != 200) {
				throw new Error('Unexpected response status on get temporary oauth_token');
			}

			if (!tmpOAuthToken) {
				throw new Error('OAuth temporary not found');
			}

			resolve(updateCtx(ctx, {tmpOAuthToken}));
		});
	});
}

function login(ctx) {
	let {tmpOAuthToken} = ctx;

	return new Promise((resolve, reject) => {
		let url = `${BASE_URL}${LOGIN_URI}`;
		let qs = {'oauth_token': tmpOAuthToken};
		let jar = CookieJar;

		request.get({url, jar, qs}, (error, {statusCode}, body) => {
			if (error) return reject(error);

			let [, hpts = ''] = body.match(/.*\("hpts"\)\.value.*?"(.*?)"/);
			let [, hptsh = ''] = body.match(/.*\("hptsh"\)\.value.*?"(.*?)"/);
			let jsSessionId = jar
				.getCookies(BASE_URL)
				.map((item) => item.toJSON())
				.filter(({key}) => key === 'JSESSIONID')[0];

			if (statusCode != 200) {
				throw new Error('Unexpected response status on login');
			}

			if (!jsSessionId) {
				throw new Error('Not found value JSESSIONID in the response cookies');
			}

			getUserCredentials().then(({username, password}) => {
				let url = `${BASE_URL}${LOGIN_URI};jsessionid=${jsSessionId}`;
				let form = {
					hpts,
					hptsh,
					username,
					password,
					login: 'Sign in',
					targetUrl: `${ACCESS_URI}?oauth_token=${tmpOAuthToken}`,
				};

				request.post({url, jar, form}, (error, {statusCode, headers: {location}}, body) => {
					if (error) return reject(error);
					if (statusCode === 200 && !location) {
						if (ctx.incorrectLogin < 3) {
							console.log('Sorry, incorrect login or password');
							console.log('Authorize...');
							ctx.incorrectLogin++;
							return login(ctx).then(resolve, reject);
						} else {
							throw new Error('Incorrect login or password');
						}
					}

					if (!location) {
						throw new Error('Target URL was not found in the response on login');
					}

					resolve(ctx);
				});
			});
		});
	});
}

function allowAccess(ctx) {
	let {tmpOAuthToken} = ctx;

	return new Promise((resolve, reject) => {
		let url = `${BASE_URL}${ACCESS_URI}`;
		let jar = CookieJar;
		let form = {
			'embed': 'false',
			'authorize': 'Authorize',
			'oauth_callback': BASE_URL,
			'oauth_token': tmpOAuthToken,
		};

		request.post({url, jar, form}, (error, {statusCode, headers: {location}}, body) => {
			if (error) return reject(error);

			let {oauth_verifier: verifierToken} = queryString.parse(location);

			if (statusCode !== 302) {
				throw new Error('Unexpected response status on allowing access');
			}

			if (!verifierToken) {
				throw new Error('OAuth verifier not found');
			}

			resolve(updateCtx(ctx, {verifierToken}));
		});
	});
}

function getOAuthToken(ctx) {
	let {tmpOAuthToken: oauth_token, verifierToken: oauth_verifier} = ctx;

	return new Promise((resolve, reject) => {
		let url = `${BASE_URL}${TOKEN_URI}`;
		let qs = merge({oauth_token, oauth_verifier}, getTokenRequestData());
		let jar = CookieJar;

		request.get({url, jar, qs}, (error, {statusCode}, body) => {
			if (error) return reject(error);

			let {oauth_token: OAuthToken} = queryString.parse(body);

			if (statusCode != 200) {
				throw new Error('Unexpected response status on getting oauth token');
			}

			if (!OAuthToken) {
				throw new Error('OAuth token not found');
			}

			resolve(updateCtx(ctx, {OAuthToken}));
		});
	});
}
