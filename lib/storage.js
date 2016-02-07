import fs from 'fs';
import path from 'path';

import debounce from 'lodash/debounce';
import chalk from 'chalk';
import mkdirp from 'mkdirp';

const STATE_SUCCESS = 'done';
const STATE_FAIL = 'failed';

export default class Storage {
	constructor(dest = './storage.json', name = 'storage') {
		this._dest = dest;
		this._name = name;
		this.init();
	}

	init() {
		this._writer = debounce((data) => {
			let dirName = path.dirname(this._dest);

			fs.existsSync(dirName) || mkdirp.sync(dirName);
			fs.writeFileSync(this._dest, JSON.stringify(data));
		}, 100);

		this._storage = this.getStorage();
	}

	getStorage() {
		let file;
		let readColor = chalk.green;
		let readState = STATE_SUCCESS;

		let collection;
		let parseColor = chalk.green;
		let parseState = STATE_SUCCESS;
		let parsingOps = 'parsing';

		if (this._storage) {
			return this._storage;
		}

		try {
			file = fs.readFileSync(this._dest);
		} catch(error) {
			file = '{}';
			readColor = chalk.red;
			readState = STATE_FAIL;
		}

		console.log(`${this._name}:`, `reading '${chalk.cyan(this._dest)}' — ${readColor(readState)}`);

		try {
			collection = JSON.parse(file);
		} catch(error) {
			collection = {};
			parseColor = chalk.red;
			parseState = STATE_FAIL;
		}

		if (readState === STATE_FAIL) {
			parsingOps = 'creating';
			this._writer(collection);
		}

		console.log(`${this._name}:`, `${parsingOps} '${chalk.cyan(this._dest)}' — ${parseColor(parseState)}`);

		return collection;
	}

	get(key) {
		return this._storage[key];
	}

	set(key, value) {
		this._storage[key] = value;
		this._writer(this._storage);
		return this;
	}
}
