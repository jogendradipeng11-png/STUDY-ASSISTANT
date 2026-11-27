import { useRef, useState } from "react";
import {
  Camera,
  Check,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  UserCheck,
  Volume2,
  X,
} from "lucide-react";
import type { FamilyProfile, ProfileRole, VoiceName } from "../types";
import {
  AVATAR_PRESETS,
  STUDY_DESK_HERO_URL,
  VOICE_OPTIONS,
} from "../data/defaults";
import { resizeImageToAvatarDataUrl } from "../utils/image";
import { LanguagePicker } from "./LanguagePicker";
import { ProfileAvatar } from "./ProfileAvatar";

interface FamilyViewProps {
  profiles: FamilyProfile[];
  activeProfileId: string;
  notesCountByProfile: Record<string, number>;
  onSelectProfile: (id: string) => void;
  onUpdateProfile: (profile: FamilyProfile) => void;
  onAddProfile: (profile: FamilyProfile) => void;
  onDeleteProfile: (id: string) => void;
}

const ACCENT_CHOICES = ["#1D4ED8", "#0F766E", "#B45309", "#4338CA", "#BE123C"];

export function FamilyView({
  profiles,
  activeProfileId,
  notesCountByProfile,
  onSelectProfile,
  onUpdateProfile,
  onAddProfile,
  onDeleteProfile,
}: FamilyViewProps) {
  const [heroImgFailed, setHeroImgFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<FamilyProfile | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<ProfileRole>("student");
  const [newGrade, setNewGrade] = useState("Grade 7");
  const [newGoal, setNewGoal] = useState(
    "Step-by-step explanations, homework help, and clear study notes"
  );
  const [newVoice, setNewVoice] = useState<VoiceName>("Zephyr");
  const [newLanguage, setNewLanguage] = useState<string>("Auto-Detect");
  const [newAvatarType, setNewAvatarType] = useState<"son" | "daughter" | "parent">("son");
  const [newCustomAvatarUrl, setNewCustomAvatarUrl] = useState<string | null>(null);

  const [testingVoice, setTestingVoice] = useState<string | null>(null);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const newPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const editPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const quickPhotoInputRef = useRef<HTMLInputElement | null>(null);
  const quickPhotoTargetIdRef = useRef<string | null>(null);

  const handleUploadNewPhoto = async (file?: File | null) => {
    if (!file) return;
    setPhotoError(null);
    try {
      const dataUrl = await resizeImageToAvatarDataUrl(file);
      setNewCustomAvatarUrl(dataUrl);
    } catch (err) {
      setPhotoError(
        err instanceof Error ? err.message : "Could not load selected photo."
      );
    }
  };

  const handleUploadDraftPhoto = async (file?: File | null) => {
    if (!file || !draft) return;
    setPhotoError(null);
    try {
      const dataUrl = await resizeImageToAvatarDataUrl(file);
      setDraft({ ...draft, avatarUrl: dataUrl });
    } catch (err) {
      setPhotoError(
        err instanceof Error ? err.message : "Could not load selected photo."
      );
    }
  };

  const handleTriggerQuickPhoto = (profileId: string) => {
    quickPhotoTargetIdRef.current = profileId;
    quickPhotoInputRef.current?.click();
  };

  const handleQuickPhotoChange = async (file?: File | null) => {
    const targetId = quickPhotoTargetIdRef.current;
    if (!file || !targetId) return;
    const target = profiles.find((p) => p.id === targetId);
    if (!target) return;
    setPhotoError(null);
    try {
      const dataUrl = await resizeImageToAvatarDataUrl(file);
      onUpdateProfile({ ...target, avatarUrl: dataUrl });
    } catch (err) {
      setPhotoError(
        err instanceof Error ? err.message : "Could not update member photo."
      );
    }
  };

  const getPresetAvatarForProfile = (profile: FamilyProfile) => {
    if (profile.role === "parent") return AVATAR_PRESETS.parent;
    if (profile.relation.toLowerCase().includes("daughter")) {
      return AVATAR_PRESETS.daughter;
    }
    return AVATAR_PRESETS.son;
  };

  const handleStartEdit = (profile: FamilyProfile) => {
    setEditingId(profile.id);
    setDraft({ ...profile });
  };

  const handleSaveEdit = () => {
    if (!draft || !draft.name.trim()) return;
    const initials = draft.name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || "")
      .join("");
    onUpdateProfile({
      ...draft,
      name: draft.name.trim(),
      initials: initials || "JJ",
    });
    setEditingId(null);
    setDraft(null);
  };

  const handleCreateMember = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const initials = trimmed
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || "")
      .join("");

    const created: FamilyProfile = {
      id: `member-${Date.now()}`,
      name: trimmed,
      relation:
        newRole === "parent"
          ? "Parent · Personal Assistant"
          : `${newAvatarType === "daughter" ? "Daughter" : "Son"} · Study Desk`,
      role: newRole,
      grade: newRole === "student" ? newGrade.trim() || "Student" : undefined,
      learningGoal: newGoal.trim(),
      voiceName: newVoice,
      preferredLanguage: newLanguage,
      avatarUrl: newCustomAvatarUrl || AVATAR_PRESETS[newAvatarType],
      initials: initials || "FM",
      accentColor: ACCENT_CHOICES[profiles.length % ACCENT_CHOICES.length],
    };

    onAddProfile(created);
    setNewName("");
    setNewCustomAvatarUrl(null);
    setShowAddForm(false);
  };

  const handlePreviewVoice = async (
    key: string,
    voiceName: VoiceName,
    role: ProfileRole,
    personName: string
  ) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setTestingVoice(key);
    setVoiceError(null);

    try {
      const sample =
        role === "student"
          ? `Hello ${personName}! I am Jogi Jarvis, your personal AI teacher. Whenever you are ready to study, ask me anything and I will help make your notes.`
          : `Hello ${personName}. Jogi Jarvis is ready whenever you need an answer, a plan, or help with the family.`;

      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sample, voiceName, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not play voice preview.");
      }

      const audio = new Audio(`data:audio/wav;base64,${data.audioBase64}`);
      audio.muted = false;
      audio.volume = 1.0;
      audioRef.current = audio;
      audio.onended = () => setTestingVoice(null);
      audio.onerror = () => setTestingVoice(null);
      await audio.play();
    } catch (err) {
      setVoiceError(
        err instanceof Error ? err.message : "Voice preview failed."
      );
      setTestingVoice(null);
    }
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#F8FAFC] p-5 sm:p-8">
      <div className="max-w-5xl mx-auto space-y-8">
        {/* Sunlit Study Desk Editorial Banner */}
        <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-900 min-h-[210px] flex items-end">
          {!heroImgFailed ? (
            <img
              src={STUDY_DESK_HERO_URL}
              alt="Sunlit family study desk with open notebook and textbooks"
              referrerPolicy="no-referrer"
              onError={() => setHeroImgFailed(true)}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-slate-800 to-slate-950" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-slate-950/85 via-slate-950/45 to-slate-950/15" />

          <div className="relative z-10 w-full p-6 sm:p-8 flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div className="space-y-1.5 max-w-xl">
              <p className="text-xs font-medium text-slate-200">
                Family Profiles &amp; Personalization
              </p>
              <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
                One Jogi Jarvis for you, your sons, and your daughter
              </h1>
              <p className="text-sm text-slate-200 leading-relaxed">
                Customize each family member&apos;s name, school grade, and
                preferred voice so Jogi Jarvis switches seamlessly between your
                personal assistant and a patient teacher for the kids.
              </p>
            </div>

            <button
              type="button"
              onClick={() => setShowAddForm((v) => !v)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-white text-slate-950 hover:bg-slate-100 text-sm font-semibold transition-colors whitespace-nowrap shrink-0 self-start sm:self-end"
            >
              {showAddForm ? (
                <X className="h-4 w-4" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              <span>{showAddForm ? "Cancel" : "Add Family Member"}</span>
            </button>
          </div>
        </section>

        {(voiceError || photoError) && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-800 flex items-center justify-between">
            <span>{photoError || voiceError}</span>
            <button
              type="button"
              onClick={() => {
                setVoiceError(null);
                setPhotoError(null);
              }}
              className="font-semibold hover:underline"
            >
              Close
            </button>
          </div>
        )}

        {/* Hidden shared file input for 1-click real photo changes on any member card */}
        <input
          ref={quickPhotoInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            void handleQuickPhotoChange(file);
          }}
        />

        {/* Add Family Member Form */}
        {showAddForm && (
          <section className="bg-white border border-slate-200 rounded-2xl p-6 space-y-5">
            <h2 className="text-lg font-bold text-slate-900">
              Add a Son, Daughter, or Family Member
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">
                  Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Rohan, Priya, Mom"
                  className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">
                  Mode
                </label>
                <select
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value as ProfileRole)}
                  className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
                >
                  <option value="student">Student · AI Teacher &amp; Notes</option>
                  <option value="parent">Parent · Personal Assistant</option>
                </select>
              </div>

              {newRole === "student" && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-slate-700">
                    Grade / Class
                  </label>
                  <input
                    type="text"
                    value={newGrade}
                    onChange={(e) => setNewGrade(e.target.value)}
                    placeholder="e.g. Grade 5, Class 10"
                    className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">
                  Real Photo or Portrait
                </label>
                <div className="flex items-center gap-2.5">
                  <img
                    src={newCustomAvatarUrl || AVATAR_PRESETS[newAvatarType]}
                    alt="Member photo preview"
                    className="h-10 w-10 rounded-full object-cover border border-slate-200 bg-slate-100 shrink-0"
                  />
                  <input
                    ref={newPhotoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      void handleUploadNewPhoto(file);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => newPhotoInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg whitespace-nowrap"
                  >
                    <Camera className="h-3.5 w-3.5 text-blue-700" />
                    <span>{newCustomAvatarUrl ? "Change Photo" : "Add Real Photo"}</span>
                  </button>
                  {newCustomAvatarUrl ? (
                    <button
                      type="button"
                      onClick={() => setNewCustomAvatarUrl(null)}
                      title="Use preset portrait"
                      className="p-2 text-slate-500 hover:text-slate-800 rounded-lg hover:bg-slate-100"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <select
                      aria-label="Fallback portrait style"
                      value={newAvatarType}
                      onChange={(e) =>
                        setNewAvatarType(
                          e.target.value as "son" | "daughter" | "parent"
                        )
                      }
                      className="min-w-0 flex-1 px-2.5 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
                    >
                      <option value="son">Boy Preset</option>
                      <option value="daughter">Girl Preset</option>
                      <option value="parent">Parent Preset</option>
                    </select>
                  )}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700">
                  Preferred Jarvis Voice
                </label>
                <select
                  value={newVoice}
                  onChange={(e) => setNewVoice(e.target.value as VoiceName)}
                  className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
                >
                  {VOICE_OPTIONS.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} — {v.tone}
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-700 block">
                  Language
                </label>
                <LanguagePicker value={newLanguage} onChange={setNewLanguage} />
              </div>

              <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
                <label className="text-xs font-semibold text-slate-700">
                  Learning Focus / Assistant Preference
                </label>
                <input
                  type="text"
                  value={newGoal}
                  onChange={(e) => setNewGoal(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-blue-600"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!newName.trim()}
                onClick={handleCreateMember}
                className="px-5 py-2 rounded-lg text-sm font-semibold bg-blue-700 hover:bg-blue-800 disabled:opacity-40 text-white"
              >
                Save Family Member
              </button>
            </div>
          </section>
        )}

        {/* Family Profiles Grid */}
        <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {profiles.map((profile) => {
            const isEditing = editingId === profile.id && draft;
            const isActive = profile.id === activeProfileId;
            const noteCount = notesCountByProfile[profile.id] || 0;

            if (isEditing && draft) {
              return (
                <div
                  key={profile.id}
                  className="bg-white border border-blue-300 rounded-2xl p-5 space-y-3.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-blue-700">
                      Editing Profile
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setDraft(null);
                      }}
                      className="text-slate-400 hover:text-slate-700"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Real Photo Picker inside Edit Form */}
                  <div className="flex items-center gap-3 pb-1">
                    <ProfileAvatar profile={draft} size="lg" />
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        ref={editPhotoInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          void handleUploadDraftPhoto(file);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => editPhotoInputRef.current?.click()}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-800 whitespace-nowrap"
                      >
                        <Camera className="h-3.5 w-3.5 text-blue-700" />
                        <span>Upload Real Photo</span>
                      </button>
                      {draft.avatarUrl?.startsWith("data:image/") && (
                        <button
                          type="button"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              avatarUrl: getPresetAvatarForProfile(draft),
                            })
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-100 whitespace-nowrap"
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Reset</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-600">
                      Name
                    </label>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) =>
                        setDraft({ ...draft, name: e.target.value })
                      }
                      className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                    />
                  </div>

                  {draft.role === "student" && (
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-600">
                        Grade / Class
                      </label>
                      <input
                        type="text"
                        value={draft.grade || ""}
                        onChange={(e) =>
                          setDraft({ ...draft, grade: e.target.value })
                        }
                        className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                      />
                    </div>
                  )}

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-600">
                      Jarvis Voice
                    </label>
                    <select
                      value={draft.voiceName}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          voiceName: e.target.value as VoiceName,
                        })
                      }
                      className="w-full px-3 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                    >
                      {VOICE_OPTIONS.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.label} — {v.tone}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-600 block">
                      Language
                    </label>
                    <LanguagePicker
                      value={draft.preferredLanguage || "Auto-Detect"}
                      onChange={(lang) =>
                        setDraft({ ...draft, preferredLanguage: lang })
                      }
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-xs font-medium text-slate-600">
                      Focus / Goal
                    </label>
                    <textarea
                      rows={2}
                      value={draft.learningGoal || ""}
                      onChange={(e) =>
                        setDraft({ ...draft, learningGoal: e.target.value })
                      }
                      className="w-full px-3 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                    />
                  </div>

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={handleSaveEdit}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-semibold"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>Save Changes</span>
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={profile.id}
                className="bg-white border border-slate-200 rounded-2xl p-6 flex flex-col justify-between space-y-5"
              >
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="relative group shrink-0">
                        <ProfileAvatar profile={profile} size="lg" />
                        <button
                          type="button"
                          onClick={() => handleTriggerQuickPhoto(profile.id)}
                          title={`Change ${profile.name}'s photo`}
                          aria-label={`Change ${profile.name}'s photo`}
                          className="absolute -bottom-1 -right-1 h-6 w-6 rounded-full bg-white border border-slate-200 shadow-xs flex items-center justify-center text-slate-700 hover:text-blue-700 hover:border-blue-300 transition-colors"
                        >
                          <Camera className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-lg font-bold text-slate-900 truncate">
                          {profile.name}
                        </h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {profile.role === "parent"
                            ? "Personal Assistant"
                            : `${profile.grade || "Student"} · AI Teacher`}
                        </p>
                      </div>
                    </div>
                    {isActive && (
                      <span className="text-xs font-semibold text-blue-700 shrink-0">
                        Active
                      </span>
                    )}
                  </div>

                  <p className="text-sm text-slate-600 leading-relaxed">
                    {profile.learningGoal ||
                      "Personalized AI guidance and study notes."}
                  </p>

                  <div className="flex items-center flex-wrap gap-x-2 gap-y-1 text-xs text-slate-500 pt-2 border-t border-slate-100">
                    <span>Voice: {profile.voiceName}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {profile.preferredLanguage &&
                      profile.preferredLanguage !== "Auto-Detect"
                        ? profile.preferredLanguage
                        : "Any Language"}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">
                      {noteCount} {noteCount === 1 ? "study note" : "study notes"}
                    </span>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onSelectProfile(profile.id)}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
                        isActive
                          ? "bg-slate-100 text-slate-800"
                          : "bg-blue-700 hover:bg-blue-800 text-white"
                      }`}
                    >
                      <UserCheck className="h-3.5 w-3.5" />
                      <span>{isActive ? "Selected" : "Switch To"}</span>
                    </button>

                    <button
                      type="button"
                      disabled={testingVoice === profile.id}
                      onClick={() =>
                        void handlePreviewVoice(
                          profile.id,
                          profile.voiceName,
                          profile.role,
                          profile.name
                        )
                      }
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 hover:bg-slate-50 text-slate-700 whitespace-nowrap"
                    >
                      {testingVoice === profile.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Volume2 className="h-3.5 w-3.5" />
                      )}
                      <span>Test</span>
                    </button>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => handleStartEdit(profile)}
                      className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                    >
                      Edit
                    </button>
                    {profiles.length > 1 && profile.id !== "jogi-parent" && (
                      <button
                        type="button"
                        onClick={() => onDeleteProfile(profile.id)}
                        aria-label={`Remove ${profile.name}`}
                        className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
