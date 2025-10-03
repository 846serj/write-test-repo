declare module 'he' {
  export interface DecodeOptions {
    isAttributeValue?: boolean;
    strict?: boolean;
  }

  export interface EncodeOptions {
    useNamedReferences?: boolean;
    decimal?: boolean;
    encodeEverything?: boolean;
    strict?: boolean;
  }

  export function decode(text: string, options?: DecodeOptions): string;
  export function encode(text: string, options?: EncodeOptions): string;

  const he: {
    decode: typeof decode;
    encode: typeof encode;
  };

  export default he;
}
