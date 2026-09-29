// Web data layer: file storage facade with local and cloud backends.

import { mode } from "./client.js";

/**
 * Cloud bucket keys are library-relative paths (design/storage.md, sync): the library's `files/`
 * folder holds what local mode serves at `/files/<path>`, so callers keep using `audio/...`,
 * `analysis/...`, `documents/...` and cloud mode adds this prefix.
 */
const CLOUD_PREFIX = "files/";
const cloudPath = (path: string): string => CLOUD_PREFIX + path;

/** One credentials fetch for everyone waiting on it; again after a sign-in or sign-out (Amplify caches the result). */
let credentials: Promise<unknown> | null = null;
function credentialsOnce(): Promise<unknown> {
  credentials ??= import("aws-amplify/auth")
    .then((a) => a.fetchAuthSession())
    .catch(() => (credentials = null)); // let the signing report it; the next call tries again
  return credentials;
}
if (typeof document !== "undefined") document.addEventListener("apricity:auth-changed", () => (credentials = null));

interface UploadDataOptions {
  contentType?: string;
}

interface FileRef {
  key: string;
  sha256?: string;
  size?: number;
  contentType?: string;
}

interface UploadDataResult {
  key: string;
}

interface GetUrlResult {
  url: string;
}

/**
 * Upload data to storage.
 * Local mode: PUT /files/<path>
 * Cloud mode: delegates to aws-amplify/storage
 */
export async function uploadData({
  path,
  data,
  options,
}: {
  path: string;
  data: Blob | File;
  options?: UploadDataOptions;
}): Promise<UploadDataResult> {
  if (mode() === "local") {
    // Local mode: PUT to /files/<path>
    const response = await fetch(`/files/${encodeURIComponent(path)}`, {
      method: "PUT",
      body: data,
      headers: options?.contentType ? { "Content-Type": options.contentType } : {},
    });
    if (!response.ok) {
      throw new Error(`Failed to upload file: ${response.statusText}`);
    }
    return { key: path };
  } else {
    // Cloud mode: use aws-amplify/storage
    const { uploadData: amplifyUpload } = await import("aws-amplify/storage");
    const result = (await amplifyUpload({
      path: cloudPath(path),
      data,
      options,
    })) as any;
    return { key: result.key || path };
  }
}

/**
 * Get a presigned URL for a file.
 * Local mode: return /files/<path>
 * Cloud mode: delegates to aws-amplify/storage
 */
export async function getUrl({
  path,
}: {
  path: string;
}): Promise<GetUrlResult> {
  if (mode() === "local") {
    // Local mode: construct a simple URL
    return {
      url: new URL(`/files/${encodeURIComponent(path)}`, location.origin).href,
    };
  } else {
    // Cloud mode: use aws-amplify/storage. Signing needs credentials; the first call fetches them and the rest wait for
    // it (called together before any are cached, each would fetch its own: a page of sounds took seconds of Cognito).
    const { getUrl: amplifyGetUrl } = await import("aws-amplify/storage");
    await credentialsOnce();
    const result = await amplifyGetUrl({ path: cloudPath(path) });
    return { url: result.url.href };
  }
}

/**
 * Download data from storage.
 * Local mode: GET /files/<path>
 * Cloud mode: delegates to aws-amplify/storage
 */
export async function downloadData({
  path,
}: {
  path: string;
}): Promise<Blob> {
  if (mode() === "local") {
    // Local mode: fetch from /files/<path>
    const response = await fetch(`/files/${encodeURIComponent(path)}`);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }
    return response.blob();
  } else {
    // Cloud mode: use aws-amplify/storage
    const { downloadData: amplifyDownload } = await import("aws-amplify/storage");
    // Amplify returns a task; the bytes are in its `result`.
    const result = await amplifyDownload({ path: cloudPath(path) }).result;
    return result.body.blob();
  }
}

/**
 * Remove a file from storage.
 * Local mode: DELETE /files/<path>
 * Cloud mode: delegates to aws-amplify/storage
 */
export async function remove({ path }: { path: string }): Promise<void> {
  if (mode() === "local") {
    // Local mode: DELETE from /files/<path>
    const response = await fetch(`/files/${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(`Failed to delete file: ${response.statusText}`);
    }
  } else {
    // Cloud mode: use aws-amplify/storage
    const { remove: amplifyRemove } = await import("aws-amplify/storage");
    await amplifyRemove({ path: cloudPath(path) });
  }
}
