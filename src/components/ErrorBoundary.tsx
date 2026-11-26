import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    errorMessage: "",
  };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error.message || "An unexpected error occurred.",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Application ErrorBoundary caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      let friendlyMsg = this.state.errorMessage;
      try {
        const parsed = JSON.parse(this.state.errorMessage) as {
          error?: string;
          operationType?: string;
        };
        if (parsed.error) {
          friendlyMsg = parsed.error.includes("Quota exceeded")
            ? "Firebase Firestore daily free quota has been reached. Quota resets tomorrow, or you can upgrade your Firebase plan."
            : `Cloud sync notice (${parsed.operationType || "database"}): ${parsed.error}`;
        }
      } catch {
        // Not a JSON FirestoreErrorInfo payload
      }

      return (
        <div className="min-h-screen bg-[#F8FAFC] flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white border border-slate-200 rounded-2xl p-6 space-y-4 shadow-sm">
            <h1 className="font-display text-lg font-bold text-slate-900">
              Jogi Jarvis hit a temporary snag
            </h1>
            <p className="text-sm text-slate-600 leading-relaxed break-words">
              {friendlyMsg}
            </p>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, errorMessage: "" });
                window.location.reload();
              }}
              className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold transition-colors"
            >
              Reload Jogi Jarvis
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
