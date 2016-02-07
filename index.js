import chalk from 'chalk';
import merge from 'merge';
import Promise from 'bluebird';
import {Evernote} from 'evernote';
import {libxmljs} from 'libxslt-prebuilt';

const {
	Note,
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

const tagsXpath = `normalize-space(substring-after(/en-note//*[contains(translate(text(), 'TТеги', 'ttags'), 'tags:')][following::hr][1], ':'))`;
const storage = new Storage();
const updates = new Storage('./updates.json', 'updates');
const ctx = {};

const processParams = process.argv
	.slice(2)
	.reduce((result, param) => {
		let [key, value] = param.split('=');
		result[key] = value;
		return result;
	}, {});

const USER_STORE_URI = "https://www.evernote.com/edam/user";

getAuthToken()
	.then(saveTokenToCtx)
	.then(() => {
		let noteStore = getNoteStore();
		let {'notebook-name': notebookName = ''} = processParams;

		noteStore
			.then(notify('Preparing...'))
			.then(runStoreMethod('listNotebooks'))
			.then(notify('Receiving notebooks info...'))
			.then((notebooks) => {
				return Promise.all(notebooks
					.filter(({name}) => !notebookName || name === notebookName)
					.map(({guid, name}) => {
						let filter = new NoteFilter({notebookGuid: guid});
						let spec = new NotesMetadataResultSpec({
							includeTitle: true,
							includeCreated: true,
							includeUpdated: true,
							includeTagGuids: true,
						});

						return noteStore
							.then(notify(`Searching for notes in "${name}"...`))
							.then(runStoreMethod('findNotesMetadata', filter, 0, EDAM_USER_NOTES_MAX, spec));
					})
				);
			})
			.then(notify('Merging notes...'))
			.then((notebooksNotes) => {
				return Array.prototype.concat.apply([], notebooksNotes.map(({notes}) => notes));
			})
			.then(notify('Filtering processed notes...'))
			.then((notes) => {
				return notes.filter(({guid}) => !updates.get(guid));
			})
			.then(notify('Processing found notes...'))
			.then((notes) => {
				return Promise.all(notes.map((note) => {
					let {guid} = note;
					return noteStore
						.then(runStoreMethod('getNoteContent', guid))
						.then((content) => merge({}, note, {content}));
				}));
			})
			.then(notify('Processing tags in notes...'))
			.then((notes) => {
				return notes.map((note) => {
					let {content} = note;
					let doc = libxmljs.parseXmlString(content);
					let tagsString = doc.find(tagsXpath);
					let tagsList = tagsString.trim().split(/\s*,\s*/);
					return merge({}, note, {tagsList});
				});
			})
			.then((notes) => {
				return noteStore
					.then(runStoreMethod('listTags'))
					.then((tagsCollection) => {
						let count = 0;
						let totalCount = notes.length;

						return Promise.all(notes.map(({guid, title, tagsList, tagGuids, created, updated}) => {
							let tagNames = [].concat(tagsList, findTagsByGuidInTagsList(tagsCollection, tagGuids));

							// Creating note's changes with preserving created and updated dates.
							let note = new Note({guid, title, tagNames, created, updated});

							console.log(`Preparing to update "${chalk.cyan(title)}" with tags: ${chalk.gray(JSON.stringify(tagNames))}`);

							return noteStore
								.then(runStoreMethod('updateNote', note))
								.then((result) => updates.set(guid, Date.now()) && result)
								.then(notify(() => `"${chalk.cyan(title)}" successfully updated! (${++count}/${totalCount})`));
						}));
					});
			})
			.then(notify('All done!'))
			.catch(handleError())
	});

function findTagsByGuidInTagsList(tagsList, tagGuids) {
	tagsList || (tagsList = []);
	tagGuids || (tagGuids = []);

	let tagsMap = tagGuids.reduce((result, guid) => {
		result[guid] = true;
		return result;
	}, {});

	return tagsList
		.filter(({guid}) => tagsMap[guid])
		.map(({name}) => name);
}

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

function notify(message) {
	return (data) => {
		if (typeof(message) === 'function') {
			console.log(message());
		} else if (message) {
			console.log(message);
		}
		return data;
	};
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
