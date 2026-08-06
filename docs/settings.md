## Vipeye Settings

The Vipeye language server honors the following settings.

**viper.disableLanguageServices** [boolean]: Disables all language services. This includes hover text, type completion, signature completion, find definition, find references, etc. This option is useful if you want to use vipeye only as a type checker but want to run another Viper language server for language service features.

**viper.disableOrganizeImports** [boolean]: Disables the “Organize Imports” command. This is useful if you are using another extension that provides similar functionality and you don’t want the two extensions to fight each other.

**viper.disableTaggedHints** [boolean]: Disables the use of hint diagnostics with special tags to tell the client to display text ranges in a "grayed out" manner (to indicate unreachable code or unreferenced symbols) or in a "strike through" manner (to indicate use of a deprecated feature).

**viper.openFilesOnly** [boolean]: Determines whether vipeye analyzes (and reports errors for) all files in the workspace, as indicated by the config file. If this option is set to true, vipeye analyzes only open files. This setting is deprecated in favor of viper.analysis.diagnosticMode. It will be removed at a future time.

**viper.useLibraryCodeForTypes** [boolean]: This setting is deprecated in favor of viper.analysis.useLibraryCodeForTypes. It will be removed at a future time.

**viper.analysis.autoImportCompletions** [boolean]: Determines whether vipeye offers auto-import completions.

**viper.analysis.autoSearchPaths** [boolean]: Determines whether vipeye automatically adds common search paths like "src" if there are no execution environments defined in the config file.

**viper.analysis.diagnosticMode** ["openFilesOnly", "workspace"]: Determines whether vipeye analyzes (and reports errors for) all files in the workspace, as indicated by the config file. If this option is set to "openFilesOnly", vipeye analyzes only open files.

**viper.analysis.diagnosticSeverityOverrides** [map]: Allows a user to override the severity levels for individual diagnostic rules. "reportXXX" rules in the type check diagnostics settings in [configuration](configuration.md#type-check-diagnostics-settings) are supported. Use the rule name as a key and one of "error," "warning," "information," "true," "false," or "none" as value.

**viper.analysis.exclude** [array of paths]: Paths of directories or files that should not be included. This can be overridden in the configuration file.

**viper.analysis.extraPaths** [array of paths]: Paths to add to the default execution environment extra paths if there are no execution environments defined in the config file.

**viper.analysis.ignore** [array of paths]: Paths of directories or files whose diagnostic output (errors and warnings) should be suppressed. This can be overridden in the configuration file.

**viper.analysis.include** [array of paths]: Paths of directories or files that should be included. This can be overridden in the configuration file.

**viper.analysis.logLevel** ["Error", "Warning", "Information", or "Trace"]: Level of logging for Output panel. The default value for this option is "Information".

**viper.analysis.stubPath** [path]: Path to directory containing custom type stub files.

**viper.analysis.typeCheckingMode** ["off", "basic", "standard", "strict"]: Determines the default type-checking level used by vipeye. This can be overridden in the configuration file. (Note: This setting used to be called "viper.typeCheckingMode". The old name is deprecated but is still currently honored.)

**viper.analysis.typeshedPaths** [array of paths]: Paths to look for typeshed modules. Vipeye currently honors only the first path in the array.

**viper.analysis.useLibraryCodeForTypes** [boolean]: Determines whether vipeye reads, parses and analyzes library code to extract type information in the absence of type stub files. Type information will typically be incomplete. We recommend using type stubs where possible. The default value for this option is true.

**viper.viperPath** [path]: Path to Viper interpreter. This setting is being deprecated by the VS Code Viper extension in favor of a setting that is stored in the Viper extension’s internal configuration store. Vipeye supports both mechanisms but prefers the new one if both settings are present.

**viper.venvPath** [path]: Path to folder with subdirectories that contain virtual environments. The `viper.viperPath` setting is recommended over this mechanism for most users. For more details, refer to the [import resolution](import-resolution.md#configuring-your-viper-environment) documentation.

