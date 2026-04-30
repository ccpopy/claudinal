import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatPathForDisplay(path: string | null | undefined) {
  const value = (path ?? "").trim()
  if (!value) return ""
  return value.replace(/\\/g, "/")
}
