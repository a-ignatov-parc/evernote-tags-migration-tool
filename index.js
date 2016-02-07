import Promise from 'bluebird';
import {Evernote} from 'evernote';

const {
	Thrift,
	UserStoreClient,
	NoteStoreClient,
	NoteFilter,
	NotesMetadataResultSpec,
} = Evernote;

const {
	EDAM_USER_NOTES_MAX,
} = Evernote;

import Storage from './lib/storage';
import getAuthTokenFromEvernote from './lib/geeknote-basic-auth';

const storage = new Storage();
const ctx = {};

const processParams = process.argv
	.slice(2)
	.reduce((result, param) => {
		let [key, value] = param.split('=');
		result[key] = value;
		return result;
	}, {});

const USER_STORE_URI = "https://www.evernote.com/edam/user"

getAuthToken()
	.then(saveTokenToCtx)
	.then(() => {
		let noteStore = getNoteStore();
		let {'notebook-name': notebookName = ''} = processParams;

		noteStore
			.then(runStoreMethod('listNotebooks'))
			.then((notebooks) => {
				let [{guid}] = notebooks.filter(({name}) => name === notebookName);
				let filter = new NoteFilter({notebookGuid: guid});
				let spec = new NotesMetadataResultSpec({
					includeTitle: true,
					includeCreated: true,
					includeUpdated: true,
					includeTagGuids: true,
					includeAttributes: true,
				});

				return noteStore.then(runStoreMethod('findNotesMetadata', filter, 0, EDAM_USER_NOTES_MAX, spec));
			})
			.then(log())
			.catch(handleError())
	});

function getAuthToken() {
	return new Promise((resolve, reject) => {
		let token = storage.get('OAuthToken');

		console.log('Restoring previous token...');

		if (token && processParams.auth !== 'renew') return resolve(token);

		console.log('Requesting token...');

		getAuthTokenFromEvernote().then(({OAuthToken}) => {
			storage.set('OAuthToken', OAuthToken);
			resolve(OAuthToken);
		}, reject);
	});
}

function saveTokenToCtx(token) {
	return ctx.authToken = token;
}

function filterSettersAndGetters(name) {
	return !~name.indexOf('send_') && !~name.indexOf('recv_');
}

function runStoreMethod(name, ...args) {
	return function(store) {
		return store[name](...args);
	}
}

function log(title = '') {
	return (result) => console.log(title, result);
}

function handleError(title = '') {
	return (error) => console.error(title, error);
}

function getUserStore() {
	if (ctx.userStore) return ctx.userStore;

	let storeTransport = new Thrift.NodeBinaryHttpTransport(USER_STORE_URI);
	let storeProtocol = new Thrift.BinaryProtocol(storeTransport);
	let userStore = new UserStoreClient(storeProtocol);

	return ctx.userStore = Promise.resolve(promisifyStore(UserStoreClient, userStore));
}

function getNoteStore() {
	if (ctx.noteStore) return ctx.noteStore;

	return ctx.noteStore = getUserStore()
		.then(runStoreMethod('getNoteStoreUrl'))
		.then((noteStoreUrl) => {
			let storeTransport = new Thrift.NodeBinaryHttpTransport(noteStoreUrl);
			let storeProtocol = new Thrift.BinaryProtocol(storeTransport);
			return new NoteStoreClient(storeProtocol);
		})
		.then((noteStore) => promisifyStore(NoteStoreClient, noteStore));
}

function promisifyStore(StoreClient, instance) {
	let store = Object.create(instance);

	Object
		.keys(StoreClient.prototype)
		.filter(filterSettersAndGetters)
		.forEach((name) => {
			store[name] = (...args) => {
				return new Promise((resolve, reject) => {
					args.unshift(ctx.authToken);
					args.push((err, result) => {
						if (err) return reject(err);
						resolve(result);
					});
					instance[name].apply(instance, args);
				});
			}
		});

	return store;
}
