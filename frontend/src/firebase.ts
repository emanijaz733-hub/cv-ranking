/**
 * Phone sign-in, through Firebase.
 *
 * Firebase sends the SMS and checks the code. That is all it does here. The
 * token it hands back proves somebody controls a number; whether that number
 * may see candidates' CVs is decided by our own server, against the same list
 * the email route uses. Do not shortcut that.
 *
 * The SDK is loaded from Google's CDN at the moment it is first needed, rather
 * than installed as an npm dependency. Two reasons, in order of importance:
 *
 *   1. Nothing is lost by it. Phone sign-in already cannot work offline — the
 *      browser has to fetch Google's reCAPTCHA script and then talk to
 *      Google's identity servers. Fetching the SDK from the same origin adds
 *      no dependency that was not already there.
 *   2. The npm package is `firebase`, an umbrella over a dozen products we do
 *      not use, and its deeply nested paths were failing to install on
 *      Windows. Not shipping it also keeps the build reproducible on a machine
 *      where that install refuses to complete.
 *
 * The trade is that a typo in an export name becomes a runtime error rather
 * than a compile error, since a URL import carries no types. The surface used
 * here is four functions wide and pinned to one SDK version, which is a small
 * enough target to be worth it.
 *
 * The config values below are not secrets. A Firebase web config ships inside
 * every page that uses it and is visible to anyone; what protects the project
 * is the authorised-domains list in the console, plus the fact that our server
 * checks the list. The service-account key, which IS a secret, lives only on
 * the server and never reaches this file.
 */

/** Pinned deliberately: "latest" would let Google change our app underneath us. */
const SDK_VERSION = "12.18.0";
const CDN = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

/** Whether this build has enough configuration to attempt phone sign-in. */
export const phoneConfigured = (): boolean =>
  Boolean(config.apiKey && config.authDomain && config.projectId && config.appId);

/** A code has been sent; call `confirm` with what the user typed. */
export type PhoneConfirmation = {
  /** Returns the Firebase ID token for our server to verify. */
  confirm(code: string): Promise<string>;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type Sdk = { app: any; auth: any };

let loading: Promise<Sdk> | null = null;

/**
 * Fetch the two SDK modules, once per page load.
 *
 * A failed load is deliberately not cached: the usual cause is a dropped
 * connection, and a second attempt a moment later should be allowed to
 * succeed rather than replaying the first failure forever.
 */
function loadSdk(): Promise<Sdk> {
  if (!loading) {
    loading = Promise.all([
      import(/* @vite-ignore */ `${CDN}/firebase-app.js`),
      import(/* @vite-ignore */ `${CDN}/firebase-auth.js`),
    ])
      .then(([app, auth]) => ({ app, auth }))
      .catch((e) => {
        loading = null;
        throw new SdkUnavailable(String(e));
      });
  }
  return loading;
}

/** The SDK itself could not be fetched — distinct from Firebase refusing us. */
class SdkUnavailable extends Error {
  readonly code = "sdk/unavailable";
}

// reCAPTCHA renders into a DOM node and refuses to render into the same node
// twice. Both the verifier and the node it used have to be let go, or a second
// attempt dies with "reCAPTCHA has already been rendered in this element".
let verifier: { clear(): void } | null = null;
let verifierNodeId: string | null = null;

export const clearRecaptcha = (): void => {
  try {
    verifier?.clear();
  } catch {
    /* Already gone, or the node was unmounted. Nothing to recover. */
  }
  verifier = null;

  // Firebase's clear() drops its own wrapper but leaves Google's widget markup
  // attached to the node, and grecaptcha still considers that node taken.
  // Emptying it is what actually frees it for a second attempt.
  if (verifierNodeId) {
    const node = document.getElementById(verifierNodeId);
    if (node) node.innerHTML = "";
    verifierNodeId = null;
  }
};

/**
 * Send an SMS code to `phoneNumber` (E.164, e.g. +923001234567).
 *
 * `containerId` is the id of an empty div the invisible reCAPTCHA can attach
 * to. It has to be in the document before this is called.
 */
export async function sendSms(
  phoneNumber: string,
  containerId: string,
): Promise<PhoneConfirmation> {
  const sdk = await loadSdk();
  const { initializeApp, getApps } = sdk.app;
  const { getAuth, RecaptchaVerifier, signInWithPhoneNumber, signOut } = sdk.auth;

  const app = getApps().length ? getApps()[0] : initializeApp(config);
  const auth = getAuth(app);
  auth.useDeviceLanguage();

  clearRecaptcha();
  const recaptcha = new RecaptchaVerifier(auth, containerId, { size: "invisible" });
  verifier = recaptcha;
  verifierNodeId = containerId;

  let result;
  try {
    result = await signInWithPhoneNumber(auth, phoneNumber, recaptcha);
  } catch (e) {
    // A refused send — a blocked region, a bad number, an exhausted quota —
    // otherwise leaves the widget sitting on the node, and the retry the
    // person immediately makes fails for a completely unrelated reason.
    clearRecaptcha();
    throw e;
  }

  return {
    confirm: async (code: string) => {
      const credential = await result.confirm(code);
      const token = await credential.user.getIdToken();
      // We have what we need. Firebase's own session is not ours and would
      // otherwise sit in this browser's storage for no purpose.
      await signOut(auth).catch(() => undefined);
      clearRecaptcha();
      return token;
    },
  };
}

/**
 * Turn a Firebase error into something worth showing a person.
 *
 * The daily-quota case matters more than it looks: a new Firebase project is
 * capped at ten SMS a day, so this is the message the team will actually hit,
 * and "an error occurred" would send somebody hunting through the code.
 */
export function phoneErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "sdk/unavailable":
      return "Could not reach Google to start phone sign-in. Check the connection, or sign in with your email and password.";
    case "auth/billing-not-enabled":
      // Firebase requires the Blaze (paid) plan before it will send any SMS.
      // Worth naming plainly: the console shows a free "10 SMS/day" quota that
      // reads as though no card is needed, and the gap between that banner and
      // this error is where an afternoon goes.
      return "Firebase will not send SMS until the project is on the paid Blaze plan. Sign in with your email and password instead.";
    case "auth/operation-not-allowed":
      return "Firebase is not allowing SMS to this country yet. In the console: Authentication → Settings → SMS region policy → allow Pakistan.";
    case "auth/invalid-phone-number":
      return "That number does not look right. Include the country code, e.g. +923001234567.";
    case "auth/missing-phone-number":
      return "Enter your phone number.";
    case "auth/quota-exceeded":
      return "This project's daily SMS limit has been reached. Sign in with your email and password instead, or try again tomorrow.";
    case "auth/too-many-requests":
      return "Too many attempts from this device. Wait a few minutes, then try again.";
    case "auth/invalid-verification-code":
      return "That code was not accepted.";
    case "auth/code-expired":
      return "That code has expired. Ask for a new one.";
    case "auth/captcha-check-failed":
    case "auth/unauthorized-domain":
      return "This address is not on the Firebase authorised-domains list. An administrator has to add it.";
    default:
      return err instanceof Error ? err.message : "Could not send the code.";
  }
}

/* ---------------------------------------------------------------------------
 * Google sign-in
 *
 * The shortest route of the three: no email at all, no code to type, no link
 * to find. Most of the people on the list already hold the Google account for
 * the address they were added under, so one click is the whole flow.
 *
 * It is not a second front door. Google proves the mailbox — exactly what the
 * emailed link proves — and the server then puts that address to the same
 * allowed-users list. Somebody with a Google account and no place on that list
 * gets the same refusal they would get anywhere else.
 * ------------------------------------------------------------------------ */

/** Sign in with Google and return the Firebase ID token for our server. */
export async function signInWithGoogle(): Promise<string> {
  const sdk = await loadSdk();
  const { initializeApp, getApps } = sdk.app;
  const { getAuth, GoogleAuthProvider, signInWithPopup, signOut } = sdk.auth;

  const app = getApps().length ? getApps()[0] : initializeApp(config);
  const auth = getAuth(app);
  auth.useDeviceLanguage();

  const provider = new GoogleAuthProvider();
  // Always ask which account. Without this, somebody already signed into a
  // personal Google account in this browser is silently signed in as that
  // one — and then refused, with no clue that the wrong account was used.
  provider.setCustomParameters({ prompt: "select_account" });

  const credential = await signInWithPopup(auth, provider);
  const token = await credential.user.getIdToken();
  // We have what we need. Firebase's own session is not ours.
  await signOut(auth).catch(() => undefined);
  return token;
}

/** Turn a Google sign-in failure into something worth showing a person. */
export function googleErrorMessage(err: unknown): string {
  const code = (err as { code?: string })?.code ?? "";
  switch (code) {
    case "sdk/unavailable":
      return "Could not reach Google to start sign-in. Check the connection and try again.";
    case "auth/popup-blocked":
      return "Your browser blocked the Google window. Allow pop-ups for this site, then try again.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      // Not an error worth alarming anybody about: they closed it themselves.
      return "";
    case "auth/operation-not-allowed":
      return "Google sign-in is not switched on in Firebase. In the console: Authentication → Sign-in method → add Google.";
    case "auth/unauthorized-domain":
      return "This address is not on the Firebase authorised-domains list. An administrator has to add it in the Firebase console.";
    default:
      return err instanceof Error ? err.message : "Could not sign in with Google.";
  }
}
