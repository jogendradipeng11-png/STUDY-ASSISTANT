import { useState } from "react";
import { Check, Copy, Download, MonitorSmartphone, X } from "lucide-react";
import { usePWAInstall } from "../hooks/usePWAInstall";

export function PWAInstallButton() {
  const { isInstallable, isInstalled, isIOS, isInIframe, install } =
    usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  // Automatically hide once running in installed standalone mode
  if (isInstalled) {
    return null;
  }

  const handleClick = async () => {
    if (isInstallable) {
      await install();
      return;
    }
    setShowGuide(true);
  };

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(window.location.origin);
      setCopiedUrl(true);
      window.setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void handleClick()}
        title="Install Jogi Jarvis as a Chrome app & desktop shortcut"
        className="inline-flex items-center gap-1.5 px-3 py-2 text-xs sm:text-sm font-semibold text-slate-800 bg-white hover:bg-slate-50 border border-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 min-h-[40px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      >
        <Download className="h-4 w-4 text-blue-700 shrink-0" />
        <span>Install App</span>
      </button>

      {showGuide && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="pwa-install-guide-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-xs p-4"
          onClick={() => setShowGuide(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white border border-slate-200 p-6 shadow-xl space-y-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center shrink-0">
                  <MonitorSmartphone className="h-5 w-5 text-blue-700" />
                </div>
                <div>
                  <h3
                    id="pwa-install-guide-title"
                    className="text-base font-bold text-slate-900"
                  >
                    {isIOS
                      ? "Install Jogi Jarvis on iPhone / iPad"
                      : "Install & Create Chrome Shortcut"}
                  </h3>
                  <p className="text-xs text-slate-500">
                    Launch Jogi Jarvis directly like a native desktop or mobile
                    app
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                aria-label="Close install instructions"
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {isIOS ? (
              <ol className="space-y-2.5 text-sm text-slate-700 list-decimal pl-5">
                <li>
                  Tap the <strong className="text-slate-900">Share</strong>{" "}
                  button in Safari&apos;s toolbar.
                </li>
                <li>
                  Scroll down and tap{" "}
                  <strong className="text-slate-900">Add to Home Screen</strong>
                  .
                </li>
                <li>
                  Tap <strong className="text-slate-900">Add</strong> to create
                  the Jogi Jarvis app icon.
                </li>
              </ol>
            ) : (
              <div className="space-y-3 text-sm text-slate-700">
                {isInIframe && (
                  <div className="rounded-xl bg-blue-50 border border-blue-200 px-3.5 py-2.5 text-xs text-blue-900 leading-relaxed">
                    Chrome shows the one-click install prompt when opened in a
                    full browser tab (such as your live site URL).
                  </div>
                )}
                <ol className="space-y-2.5 list-decimal pl-5">
                  <li>
                    In Google Chrome, click the{" "}
                    <strong className="text-slate-900">Install</strong> icon on
                    the right side of the address bar, then click{" "}
                    <strong className="text-slate-900">Install</strong>.
                  </li>
                  <li>
                    Or click Chrome&apos;s{" "}
                    <strong className="text-slate-900">⋮ Menu</strong> →{" "}
                    <strong className="text-slate-900">
                      Cast, save, and share
                    </strong>{" "}
                    →{" "}
                    <strong className="text-slate-900">
                      Install page as app…
                    </strong>{" "}
                    (or <strong className="text-slate-900">Create shortcut…</strong>{" "}
                    with <strong className="text-slate-900">Open as window</strong>{" "}
                    checked).
                  </li>
                  <li>
                    On Android Chrome, tap{" "}
                    <strong className="text-slate-900">⋮ Menu</strong> →{" "}
                    <strong className="text-slate-900">Install app</strong> or{" "}
                    <strong className="text-slate-900">
                      Add to Home screen
                    </strong>
                    .
                  </li>
                </ol>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              {!isIOS && (
                <button
                  type="button"
                  onClick={() => void handleCopyUrl()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors whitespace-nowrap"
                >
                  {copiedUrl ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-700" />
                      <span>URL Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Copy App URL</span>
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 transition-colors whitespace-nowrap"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
