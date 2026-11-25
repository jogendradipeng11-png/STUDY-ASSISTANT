import { useEffect, useState } from "react";
import type { FamilyProfile } from "../types";

interface ProfileAvatarProps {
  profile: FamilyProfile;
  size?: "sm" | "md" | "lg";
}

const SIZE_CLASSES: Record<"sm" | "md" | "lg", string> = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-base",
};

export function ProfileAvatar({ profile, size = "md" }: ProfileAvatarProps) {
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    setImgFailed(false);
  }, [profile.avatarUrl]);

  if (profile.avatarUrl && !imgFailed) {
    return (
      <img
        src={profile.avatarUrl}
        alt={`${profile.name} portrait`}
        referrerPolicy="no-referrer"
        onError={() => setImgFailed(true)}
        className={`${SIZE_CLASSES[size]} shrink-0 rounded-full object-cover border border-slate-200 bg-slate-100`}
      />
    );
  }

  return (
    <div
      aria-label={`${profile.name} avatar`}
      style={{ backgroundColor: profile.accentColor }}
      className={`${SIZE_CLASSES[size]} shrink-0 rounded-full flex items-center justify-center font-semibold text-white tracking-tight`}
    >
      {profile.initials}
    </div>
  );
}
