import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import {
  Check,
  Cloud,
  CloudOff,
  Loader2,
  LogOut,
  RefreshCw,
} from "lucide-react";

interface CloudSyncButtonProps {
  user: User | null;
  authReady: boolean;
  syncStatus: "idle" | "syncing" | "synced" | "error";
  syncError: string | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  onBackupNow: () => Promise<void>;
}

export function CloudSyncButton({
  user,
  authReady,
  syncStatus,
  syncError,
  onSignIn,
  onSignOut,
  onBackupNow,
}: CloudSyncButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupDone, setBackupDone] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    if (menuOpen) {
      document.addEventListener("mousedown", handleOutside);
    }
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [menuOpen]);

  if (!authReady) {
    return (
      <div className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <button
        type="button"
        disabled={signingIn}
        onClick={async () => {
          setSigningIn(true);
          try {
            await onSignIn();
          } finally {
            setSigningIn(false);
          }
        }}
        title="Sign in with Google to back up and sync all family profiles, Study Notes, chats, and alarms across all devices"
        className="inline-flex items-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs sm:text-sm font-semibold text-slate-700 bg-white hover:bg-blue-50 hover:text-blue-800 border border-slate-200 hover:border-blue-200 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
      >
        {signingIn ? (
          <Loader2 className="h-4 w-4 animate-spin text-blue-700 shrink-0" />
        ) : (
          <Cloud className="h-4 w-4 text-blue-700 shrink-0" />
        )}
        <span className="hidden sm:inline">
          {signingIn ? "Signing in..." : "Cloud Sync"}
        </span>
      </button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        title={`Cloud Sync active for ${user.displayName || user.email || "your account"}`}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px]"
      >
        {syncStatus === "syncing" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-700 shrink-0" />
        ) : syncStatus === "error" ? (
          <CloudOff className="h-3.5 w-3.5 text-red-600 shrink-0" />
        ) : (
          <Cloud className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
        )}
        {user.photoURL ? (
          <img
            src={user.photoURL}
            alt={user.displayName || "Account"}
            referrerPolicy="no-referrer"
            className="h-5 w-5 rounded-full object-cover border border-emerald-300"
          />
        ) : (
          <span className="hidden sm:inline">Synced</span>
        )}
      </button>

      {menuOpen && (
        <div className="absolute right-0 mt-2 w-64 rounded-xl bg-white border border-slate-200 shadow-lg p-3 z-50 space-y-2.5">
          <div className="pb-2 border-b border-slate-100">
            <p className="text-xs font-semibold text-slate-900 truncate">
              {user.displayName || "Google Account"}
            </p>
            <p className="text-[11px] text-slate-500 truncate">{user.email}</p>
            <p className="text-[11px] text-emerald-700 font-medium mt-1">
              {syncStatus === "syncing"
                ? "Syncing with Firebase Cloud..."
                : syncStatus === "error"
                  ? "Cloud sync paused — retry below"
                  : "All notes, profiles & alarms synced"}
            </p>
            {syncError && (
              <p className="text-[11px] text-red-600 mt-1 break-words">
                {syncError}
              </p>
            )}
          </div>

          <button
            type="button"
            disabled={backingUp}
            onClick={async () => {
              setBackingUp(true);
              setBackupDone(false);
              try {
                await onBackupNow();
                setBackupDone(true);
                window.setTimeout(() => setBackupDone(false), 2500);
              } finally {
                setBackingUp(false);
              }
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-slate-100 hover:bg-blue-50 text-xs font-semibold text-slate-800 hover:text-blue-800 transition-colors disabled:opacity-50"
          >
            {backingUp ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : backupDone ? (
              <Check className="h-3.5 w-3.5 text-emerald-600" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            <span>
              {backingUp
                ? "Backing up..."
                : backupDone
                  ? "Backed up to Cloud!"
                  : "Backup This Device Now"}
            </span>
          </button>

          <button
            type="button"
            onClick={async () => {
              setMenuOpen(false);
              await onSignOut();
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-red-700 hover:bg-red-50 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span>Sign Out</span>
          </button>
        </div>
      )}
    </div>
  );
}
