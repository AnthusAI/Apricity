// Web data layer: file storage facade with local and cloud backends.

import { mode } from "./client.js";

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
      path,
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
    // Cloud mode: use aws-amplify/storage
    const { getUrl: amplifyGetUrl } = await import("aws-amplify/storage");
    const result = await amplifyGetUrl({ path });
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
    const result = (await amplifyDownload({ path })) as any;
    return result.body || result;
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
    await amplifyRemove({ path });
  }
}
