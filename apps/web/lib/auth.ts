"use client";

import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoUserSession,
} from "amazon-cognito-identity-js";

const mode = process.env.NEXT_PUBLIC_AUTH_MODE || "local";
const poolId = process.env.NEXT_PUBLIC_USER_POOL_ID || "";
const clientId = process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID || "";

function pool() {
  return new CognitoUserPool({ UserPoolId: poolId, ClientId: clientId });
}

export async function login(email: string, password: string) {
  if (mode === "local") {
    sessionStorage.setItem("recruiter", JSON.stringify({ email }));
    return;
  }
  const user = new CognitoUser({ Username: email, Pool: pool() });
  await new Promise<CognitoUserSession>((resolve, reject) => {
    user.authenticateUser(new AuthenticationDetails({ Username: email, Password: password }), {
      onSuccess: resolve,
      onFailure: reject,
    });
  });
  sessionStorage.setItem("recruiter", JSON.stringify({ email }));
}

export async function signup(email: string, password: string) {
  if (mode === "local") {
    sessionStorage.setItem("recruiter", JSON.stringify({ email }));
    return;
  }
  await new Promise((resolve, reject) => {
    pool().signUp(email, password, [], [], (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

export function currentRecruiter(): { email: string } | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem("recruiter");
  return raw ? (JSON.parse(raw) as { email: string }) : null;
}

export function logout() {
  sessionStorage.removeItem("recruiter");
}
