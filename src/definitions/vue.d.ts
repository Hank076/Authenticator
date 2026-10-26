// `export {}` keeps this file a module so the block below AUGMENTS vue.
// Without it the file is a script and `declare module` becomes an ambient
// declaration that SHADOWS the real module, erasing vue's re-exported members
// (ref/computed/...) program-wide. (An `import` from the old state-management
// library used to provide this module scope; it was removed during the Pinia
// migration.)
// Augment "vue", not "@vue/runtime-core": the latter is only a transitive
// dependency, so pnpm's strict node_modules layout does not expose it and an
// augmentation of it is silently dropped.
export {};

declare module "vue" {
  interface ComponentCustomProperties {
    // Only in Import
    $entries: OTPEntryInterface[];
    $encryption: EncryptionInterface;
    $passwordRequired: boolean;
    $locked: boolean;
    // In all
    i18n: { [key: string]: string };
  }
}
