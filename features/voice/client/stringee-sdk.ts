/** Public Hanoi project configuration. No provider credential belongs in this module. */
export const STRINGEE_SERVER_ADDRS = ['wss://v1.stringee.com:6899/', 'wss://v2.stringee.com:6899/'];

export type StringeeResult = { r?: number; message?: string; userId?: string };
export type StringeeState = { reason?: string; code?: number };
export type StringeeTrack = { attach?: (audioOnly?: boolean) => HTMLElement; detachAndRemove?: () => void };
export type StringeeCallLike = {
  callId?: string;
  makeCall: (callback?: (result: StringeeResult) => void) => void;
  answer: (callback?: (result: StringeeResult) => void) => void;
  reject?: (callback?: (result: StringeeResult) => void) => void;
  hangup: (callback?: (result: StringeeResult) => void) => void;
  on: (event: string, callback: (...args: never[]) => void) => void;
};
export type StringeeClientLike = {
  connect: (accessToken: string) => void;
  disconnect: () => void;
  on: (event: string, callback: (...args: never[]) => void) => void;
};

declare global {
  interface Window {
    StringeeClient?: new (servers?: string[]) => StringeeClientLike;
    StringeeCall?: new (client: StringeeClientLike, from: string, to: string, video: boolean) => StringeeCallLike;
    StringeeCall2?: new (client: StringeeClientLike, from: string, to: string, video: boolean) => StringeeCallLike;
  }
}

let sdkPromise: Promise<void> | undefined;
export async function ensureStringeeSdk(): Promise<void> {
  if (window.StringeeClient) return;
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = window.setTimeout(() => { script.remove(); reject(new Error('STRINGEE_SDK_TIMEOUT')); }, 15_000);
      script.src = 'https://cdn.stringee.com/sdk/web/latest/stringee-web-sdk.min.js';
      script.async = true;
      script.dataset.crmStringeeSdk = 'true';
      script.onload = () => {
        window.clearTimeout(timeout);
        if (window.StringeeClient) resolve();
        else reject(new Error('STRINGEE_SDK_UNAVAILABLE'));
      };
      script.onerror = () => { window.clearTimeout(timeout); script.remove(); reject(new Error('STRINGEE_SDK_LOAD_FAILED')); };
      document.head.appendChild(script);
    }).catch((error) => { sdkPromise = undefined; throw error; });
  }
  return sdkPromise;
}
