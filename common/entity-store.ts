import { Criteria, Filter } from './criteria';

type AnyEntity = { id?: number };


export function makeEntityStore(storeRW: StoreRW): EntityStore {
	return new EntityStoreImpl(storeRW);
}

export type EntityDictionary = { [id: number]: object };

/** Interface of the methods to be called by StoreRW implement  */
export type BeforeWrite = (entityStore: EntityDictionary) => Promise<any>;

/** Interface that read and write a EntityDictionary to storage. 
 * A file-store will read/write to file, a mem-store will get/set to a js object.
 */
export interface StoreRW {
	read(entityTypeName: string): Promise<EntityDictionary>;
	readWrite(entityTypeName: string, beforeWrite: BeforeWrite): Promise<any>;
}


export interface EntityStore {
	create(type: string, data: object): Promise<AnyEntity>;
	update(type: string, id: number, data: object): Promise<AnyEntity>;
	get(type: string, id: number): Promise<AnyEntity | null>;
	first(type: string, criteria?: Criteria): Promise<AnyEntity | null>;
	list(type: string, criteria?: Criteria): Promise<AnyEntity[]>;
	remove(type: string, id: number): Promise<boolean>
}

class EntityStoreImpl implements EntityStore {
	private storeProvider: StoreRW;

	constructor(storeProvider: StoreRW) {
		this.storeProvider = storeProvider;
	}

	async create(type: string, data: object): Promise<AnyEntity> {
		// Here we need to have a readWrite lock, to make it atomic (prevent other concurrent access because of nio to intermingle)
		return this.storeProvider.readWrite(type, async (entityStore: EntityDictionary) => {
			// get the next sequence id
			let id = nextSeq(entityStore);

			// make a shallow copy of
			let newEntity: { id?: number } = Object.assign({}, data);
			newEntity.id = id;

			// add it to the store. 
			entityStore[id] = newEntity;

			return Object.assign({}, newEntity);
		});
	}

	async update(type: string, id: number, data: object): Promise<AnyEntity> {
		// Here we need to have a readWrite lock, to make it atomic (prevent other concurrent access because of nio to intermingle)
		return this.storeProvider.readWrite(type, async (entityStore: EntityDictionary) => {
			let entity = entityStore[id];
			if (entity == null) {
				throw new Error(`Can't update entity of type ${type} with id ${id} because not found ${entity}`);
			}
			let updatedEntity = Object.assign({}, entity, data);

			entityStore[id] = updatedEntity;

			// return a clone
			return Object.assign({}, updatedEntity);
		});
	}

	async get(type: string, id: number): Promise<AnyEntity | null> {
		// we do not write, so, we just need to read, with no lock. 
		let entityStore = await this.storeProvider.read(type);

		let entity = (entityStore) ? entityStore[id] : null;

		// make sure to return a copy (for now, shallow copy)
		return (entity) ? Object.assign({}, entity as AnyEntity) : null;
	}

	async first(type: string, criteria?: Criteria): Promise<AnyEntity | null> {
		criteria = Object.assign({}, criteria, { limit: 1 });
		let ls = await this.list(type, criteria);
		return (ls && ls.length > 0) ? ls[0] : null;
	}

	async list(type: string, criteria?: Criteria): Promise<AnyEntity[]> {
		let tmpList: AnyEntity[] = [], list: AnyEntity[];

		let entityStore = await this.storeProvider.read(type);

		let item;

		// get the eventual filters
		let filters = (criteria && criteria.filter) ? criteria.filter : null;
		if (filters) {
			// make sure it is an array of filter
			filters = (filters instanceof Array) ? filters : [filters];
		}


		// first, we go through the store to build the first list
		// NOTE: Here we do the filter here because we have to build the list anyway. 
		//       If we had the list as storage, we will sort first, and then, filter
		for (let k in entityStore) {
			item = entityStore[k] as AnyEntity;
			// add it to the list if no filters or it passes the filters
			if (!filters || passFilter(item, filters)) {
				tmpList.push(item);
			}
		}

		// TODO: implement the sorting
		// get the eventual orgerBy
		// let orderBy = (opts && opts.orderBy)?opts.orderBy:null;
		// tmpList.sort...

		// extract the eventual offset, limit from the opts, or set the default
		let offset = (criteria && criteria.offset) ? criteria.offset : 0;
		let limit = (criteria && criteria.limit) ? criteria.limit : -1; // -1 means no limit

		// Set the "lastIndex + 1" for the for loop
		let l = (limit !== -1) ? (offset + limit) : tmpList.length;
		// make sure the l is maxed out by the tmpList.length
		l = (l > tmpList.length) ? tmpList.length : l;

		list = [];
		for (let i = offset; i < l; i++) {
			list.push(Object.assign({}, tmpList[i]));
		}

		return list;
	}

	async remove(type: string, id: number): Promise<boolean> {
		// Here we need to have a readWrite lock, to make it atomic (prevent other concurrent access because of nio to intermingle)
		return this.storeProvider.readWrite(type, async (entityStore: EntityDictionary) => {
			if (id != null && entityStore[id] != null) {
				delete entityStore[id];
				return true;
			} else {
				return false;
			}
		});
	}

}


// --------- Utils --------- //

/** Return the next sequence number (+1 of the max) */
// TODO: Will need to make it more efficient by caching the max the first time, and then, just increment it (since everything go through the same code)
//       For now, we do it save. 
function nextSeq(entityStore: object) {
	let num = -1;
	for (let idStr in entityStore) {
		let id = parseInt(idStr);
		if (id > num) {
			num = id;
		}
	}
	return num + 1;
}

function ensureObject(root: any, name: string) {
	let obj = root[name];
	if (!obj) {
		obj = new Map();
		root[name] = obj;
	}
	return obj;
}


let filterDefaultOp = "=";

// Important: filters must be an array
function passFilter(item: any, filters: Filter[]) {

	let pass;

	// each condition in a filter are OR, so, first match we can break out.
	// A condition item is a js object, and each property is a AND
	let i = 0, l = filters.length, cond, k, v, propName, op, itemV;
	for (; i < l; i++) {
		pass = true;

		cond = filters[i];
		for (k in cond) {
			// TODO: For now, just support the simple case where key is the property name
			//       Will need to add support for the operator in the key name
			propName = k;
			op = filterDefaultOp; // TODO: will need to get it for key

			// value to match
			v = cond[k];

			// item value
			itemV = item[propName];


			switch (op) {
				case "=":
					// special case if v is null (need to test undefined)
					if (v === null) {
						pass = pass && (itemV == null);
					} else {
						pass = pass && (v === itemV);
					}

					break;
			}

			// if one fail, break at false, since within an object, we have AND
			if (!pass) {
				break;
			}
		}

		// if one of those condition pass, we can return true since within the top filter array we have OR.
		if (pass) {
			break;
		}
	}

	return pass;
}
// --------- /Utils --------- //