import { File } from 'expo-file-system';

/**
 * A photo on the device as a multipart part. Expo 57 installs expo/fetch as the global fetch; its
 * FormData encoder reads each file part's bytes itself (`bytes()`) and throws on React Native's
 * `{ uri, name, type }` parts, which surfaced as "Couldn't reach the server" on every upload.
 * expo-file-system's File carries its own name, type and bytes. The server reads the image type
 * from the bytes, not from the part. Needs expo/fetch: do not set EXPO_PUBLIC_USE_RN_FETCH.
 */
export function localFilePart(uri: string): Blob {
  return new File(uri);
}
