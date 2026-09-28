"use server";

import { revalidatePath } from "next/cache";
import { changeAvatar } from "@/lib/profile/avatar";
import { savePersonalInformation, saveTennisProfile } from "@/lib/profile/profile";
import { personalInformationSchema, tennisProfileSchema, profileFormInput, type ProfileActionState } from "@/lib/profile/validation";

function refreshOnSuccess(result: ProfileActionState) {
  if (result.success) revalidatePath("/profile");
  return result;
}

export async function savePersonalAction(_state: ProfileActionState, formData: FormData) {
  return refreshOnSuccess(await savePersonalInformation(profileFormInput(formData, Object.keys(personalInformationSchema.shape))));
}

export async function saveTennisAction(_state: ProfileActionState, formData: FormData) {
  return refreshOnSuccess(await saveTennisProfile(profileFormInput(formData, Object.keys(tennisProfileSchema.shape))));
}

export async function uploadAvatarAction(_state: ProfileActionState, formData: FormData): Promise<ProfileActionState> {
  const file = formData.get("avatar");
  if (!(file instanceof File)) return { fieldErrors: { avatar: "Choose an image to upload." } };
  return refreshOnSuccess(await changeAvatar(file));
}

export async function removeAvatarAction() {
  return refreshOnSuccess(await changeAvatar(null));
}
