import { beforeEach, expect, it, vi } from "vitest";
import { personalInformationSchema, tennisProfileSchema } from "../../../src/lib/profile/validation";
const { personal, tennis, avatar, revalidatePath } = vi.hoisted(() => ({ personal: vi.fn(), tennis: vi.fn(), avatar: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("../../../src/lib/profile/profile", () => ({ savePersonalInformation: personal, saveTennisProfile: tennis }));
vi.mock("../../../src/lib/profile/avatar", () => ({ changeAvatar: avatar }));
vi.mock("next/cache", () => ({ revalidatePath }));
import { savePersonalAction, saveTennisAction, uploadAvatarAction, removeAvatarAction } from "../../../src/app/profile/actions";
beforeEach(() => vi.resetAllMocks());
it("passes only personal fields, dropping identity, status, and timestamps", async () => {
  const data = new FormData(); data.set("first_name", "Ana"); data.set("id", "victim"); data.set("status", "suspended"); data.set("updated_at", "now");
  personal.mockResolvedValue({ success: "Saved" });
  await savePersonalAction({}, data);
  expect(personal).toHaveBeenCalledWith({ ...Object.fromEntries(Object.keys(personalInformationSchema.shape).map((key) => [key, ""])), first_name: "Ana" });
  expect(revalidatePath).toHaveBeenCalledExactlyOnceWith("/profile");
});
it("drops rating, ownership, and avatar input from the tennis action", async () => {
  const data = new FormData(); data.set("rating", "2500"); data.set("user_id", "victim"); data.set("avatar_path", "injected");
  tennis.mockResolvedValue({ fieldErrors: { display_name: "Invalid" } });
  await saveTennisAction({}, data);
  expect(tennis).toHaveBeenCalledWith(Object.fromEntries(Object.keys(tennisProfileSchema.shape).map((key) => [key, ""])));
  expect(revalidatePath).not.toHaveBeenCalled();
});
it("requires a File for upload and delegates removal without client ownership", async () => {
  expect(await uploadAvatarAction({}, new FormData())).toHaveProperty("fieldErrors.avatar"); expect(avatar).not.toHaveBeenCalled();
  avatar.mockResolvedValue({ success: "Removed" }); await removeAvatarAction();
  expect(avatar).toHaveBeenCalledExactlyOnceWith(null); expect(revalidatePath).toHaveBeenCalledWith("/profile");
});
