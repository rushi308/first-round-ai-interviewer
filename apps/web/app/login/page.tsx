"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppHeader } from "@/components/ui/AppHeader";
import { useToast } from "@/components/ui/Toast";
import { login, signup } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState("recruiter@example.com");
  const [password, setPassword] = useState("Password1!");
  const [mode, setMode] = useState<"login" | "signup">("login");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (mode === "signup") await signup(email, password);
      else await login(email, password);
      toast.success("Welcome in", "Opening your recruiter dashboard.");
      router.push("/app");
    } catch (err) {
      toast.error("Couldn’t sign in", err instanceof Error ? err.message : "Auth failed");
    }
  }

  return (
    <main className="min-h-screen">
      <AppHeader
        right={
          <Link href="/" className="text-sm text-[var(--studio-muted)]">
            Back
          </Link>
        }
      />
      <div className="mx-auto flex max-w-md flex-col px-6 pt-10">
        <h1 className="text-3xl font-semibold tracking-tight">Recruiter access</h1>
        <p className="mt-2 text-[var(--studio-muted)]">
          Local mode accepts any credentials. Cognito is used when deployed.
        </p>
        <form onSubmit={onSubmit} className="card mt-8 space-y-4 p-7">
          <div>
            <label className="label">Email</label>
            <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
            />
          </div>
          <button className="btn-primary w-full py-3">{mode === "login" ? "Continue" : "Create account"}</button>
        </form>
        <button
          className="mt-4 text-sm text-[var(--studio-muted)]"
          onClick={() => setMode(mode === "login" ? "signup" : "login")}
        >
          {mode === "login" ? "Need an account? Sign up" : "Have an account? Log in"}
        </button>
      </div>
    </main>
  );
}
