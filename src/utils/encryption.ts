import CryptoJS from 'crypto-js';

const SECRET_KEY = process.env.SECRET_KEY as string;

if (!SECRET_KEY) {
  throw new Error('Missing SECRET_KEY in environment variables');
}

export function encrypt(text: string): string {
  return CryptoJS.AES.encrypt(text, SECRET_KEY).toString();
}

export function decrypt(ciphertext: string): string {
  const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET_KEY);
  const decrypted = bytes.toString(CryptoJS.enc.Utf8);

  if (!decrypted) {
    throw new Error('Failed to decrypt value. Possibly invalid SECRET_KEY or corrupted data.');
  }

  return decrypted;
}
