// Exposes the Ultima Online data files, served over HTTP (see tools/nginx), as files of the emscripten
// filesystem so ClassicUO finds them where it expects them (settings "ultimaonlinedirectory", e.g. /uo).
//
// The files are lazy: only the file list (a JSON directory listing, nginx "autoindex_format json") is read at
// startup. Content is downloaded in blocks, with HTTP Range requests, the first time a part of a file is read.
//
// ClassicUO reads files synchronously, so the reads here are synchronous XMLHttpRequests. Browsers allow them
// on the main thread (deprecated, but supported) as long as the request is same-origin or CORS enabled.

const BLOCK_SIZE = 1024 * 1024;          // bytes fetched per request
const CACHE_LIMIT = 512 * 1024 * 1024;   // bytes of downloaded blocks kept in memory (oldest dropped first)

export const stats = { requests: 0, bytes: 0, files: 0, totalSize: 0, cachedBytes: 0 };

const cache = new Map();                 // "fileId:block" -> Uint8Array, in insertion (= least recently used) order
let nextFileId = 0;

function fetchRangeSync(url, start, endInclusive) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.setRequestHeader('Range', `bytes=${start}-${endInclusive}`);
    // Binary data from a synchronous XHR on the main thread: responseType can't be set, so read it as
    // "user defined" text where every char is one byte.
    xhr.overrideMimeType('text/plain; charset=x-user-defined');
    xhr.send(null);

    if (xhr.status !== 206 && xhr.status !== 200) {
        throw new Error(`HTTP ${xhr.status} for ${url} (bytes ${start}-${endInclusive})`);
    }

    const text = xhr.responseText;
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;

    stats.requests++;
    stats.bytes += bytes.length;

    // a server without Range support answers 200 with the whole file
    return xhr.status === 200 ? bytes.subarray(start, endInclusive + 1) : bytes;
}

function getBlock(fileId, url, size, index) {
    const key = `${fileId}:${index}`;
    let block = cache.get(key);

    if (block) {
        cache.delete(key);               // refresh LRU position
        cache.set(key, block);
        return block;
    }

    const start = index * BLOCK_SIZE;
    const end = Math.min(size, start + BLOCK_SIZE) - 1;
    block = fetchRangeSync(url, start, end);

    cache.set(key, block);
    stats.cachedBytes += block.length;

    while (stats.cachedBytes > CACHE_LIMIT && cache.size > 1) {
        const oldest = cache.keys().next().value;
        stats.cachedBytes -= cache.get(oldest).length;
        cache.delete(oldest);
    }

    return block;
}

function createLazyFile(FS, directory, name, url, size) {
    const fileId = nextFileId++;
    const node = FS.createFile(directory, name, null, true, false);

    Object.defineProperty(node, 'usedBytes', { get: () => size });

    node.stream_ops = {
        read(stream, buffer, offset, length, position) {
            if (position >= size) return 0;

            const count = Math.min(length, size - position);
            let done = 0;

            while (done < count) {
                const pos = position + done;
                const index = Math.floor(pos / BLOCK_SIZE);
                const block = getBlock(fileId, url, size, index);
                const within = pos - index * BLOCK_SIZE;
                const take = Math.min(count - done, block.length - within);

                buffer.set(block.subarray(within, within + take), offset + done);
                done += take;
            }

            return count;
        },

        llseek(stream, offset, whence) {
            let position = offset;
            if (whence === 1) position += stream.position;         // SEEK_CUR
            else if (whence === 2) position += size;                // SEEK_END
            if (position < 0) throw new FS.ErrnoError(28);          // EINVAL
            return position;
        },
    };

    stats.files++;
    stats.totalSize += size;
}

async function fetchDirectoryListing(listUrl) {
    // 1. Static hosts (GitHub Pages / Cloudflare Pages / local HTTP servers): prefer index.json
    const manifestResp = await fetch(`${listUrl}index.json`);
    if (manifestResp.ok) {
        const ct = manifestResp.headers.get('content-type') || '';
        if (ct.includes('json') || manifestResp.url.endsWith('index.json')) {
            return await manifestResp.json();
        }
    }

    // 2. Fallback to nginx autoindex_format json
    const response = await fetch(listUrl);
    if (!response.ok) throw new Error(`Cannot list ${listUrl}: HTTP ${response.status}`);
    return await response.json();
}

async function mountDirectory(FS, listUrl, mountPath) {
    const entries = await fetchDirectoryListing(listUrl);

    FS.mkdirTree(mountPath);

    for (const entry of entries) {
        if (entry.type === 'directory') {
            await mountDirectory(FS, `${listUrl}${encodeURIComponent(entry.name)}/`, `${mountPath}/${entry.name}`);
        } else if (entry.type === 'file') {
            createLazyFile(FS, mountPath, entry.name, `${listUrl}${encodeURIComponent(entry.name)}`, entry.size);
        }
    }
}

/**
 * @param FS         the emscripten filesystem of the .NET runtime
 * @param baseUrl    URL of the Ultima Online data folder (ends with "/", serves a JSON listing and Range requests)
 * @param mountPath  where the files appear in the virtual filesystem, e.g. "/uo"
 */
export async function mountUoFiles(FS, baseUrl, mountPath) {
    const url = new URL(baseUrl, location.href).href;
    await mountDirectory(FS, url.endsWith('/') ? url : url + '/', mountPath);
    return stats;
}
