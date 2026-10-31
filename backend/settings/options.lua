local options = {}

options.SETTINGS_GROUPS = {
    {
        key = "general",
        label = "General",
        description = "Global Akram's preferences.",
        options = {
            {
                key = "displayName",
                label = "Display Name",
                option_type = "text",
                description = "Change the name shown inside the Steam interface.",
                default = "Akram's",
                metadata = {placeholder = "Akram's", maxLength = 32}
            },
            {
                key = "language",
                label = "Language",
                option_type = "select",
                description = "Choose the language used by Akram's.",
                default = "ar",
                metadata = {dynamicChoices = "locales"}
            },
            {
                key = "theme",
                label = "Theme",
                option_type = "select",
                description = "Choose the color theme for Akram's interface.",
                default = "original",
                metadata = {dynamicChoices = "themes"}
            },
            {
                key = "fastDownload",
                label = "Fast Download",
                option_type = "toggle",
                description = "Automatically choose the first available source when adding a game.",
                default = true,
                metadata = {yesLabel = "Yes", noLabel = "No"}
            },
            {
                key = "localSavesOnly",
                label = "الحفظ المحلي فقط",
                option_type = "toggle",
                description = "يعطّل Steam Cloud تلقائيًا للألعاب المضافة بواسطة Akram's حتى تبقى ملفات الحفظ على الجهاز.",
                default = true,
                metadata = {yesLabel = "نعم", noLabel = "لا"}
            },
            {
                key = "morrenusApiKey",
                label = "Morrenus API Key",
                option_type = "text",
                description = "API Key required to use Sadie Source. Get from hubcapmanifest.com",
                default = "",
                metadata = {placeholder = "Enter your API key..."}
            },
            {
                key = "licenseKey",
                label = "كود التفعيل",
                option_type = "text",
                description = "كود تفعيل الإضافة (AK-YYYYMMDD-XXXX). الإضافة مقفلة بدونه.",
                default = "",
                metadata = {placeholder = "AK-20271031-0000", maxLength = 24}
            }
        }
    }
}

function options.get_settings_schema()
    local schema = {}
    for _, group in ipairs(options.SETTINGS_GROUPS) do
        local group_options = {}
        for _, opt in ipairs(group.options) do
            table.insert(group_options, {
                key = opt.key,
                label = opt.label,
                type = opt.option_type,
                description = opt.description,
                default = opt.default,
                choices = opt.choices or {},
                requiresRestart = opt.requires_restart or false,
                metadata = opt.metadata or {}
            })
        end
        table.insert(schema, {
            key = group.key,
            label = group.label,
            description = group.description,
            options = group_options
        })
    end
    return schema
end

function options.get_default_settings_values()
    local defaults = {}
    for _, group in ipairs(options.SETTINGS_GROUPS) do
        local group_defaults = {}
        for _, opt in ipairs(group.options) do
            group_defaults[opt.key] = opt.default
        end
        defaults[group.key] = group_defaults
    end
    return defaults
end

function options.merge_defaults_with_values(values)
    local merged = type(values) == "table" and values or {}
    local defaults = options.get_default_settings_values()

    for group_key, group_defaults in pairs(defaults) do
        local existing_group = merged[group_key]
        if type(existing_group) ~= "table" then
            existing_group = {}
        end
        local merged_group = {}
        for k, v in pairs(group_defaults) do merged_group[k] = v end
        for k, v in pairs(existing_group) do merged_group[k] = v end
        merged[group_key] = merged_group
    end
    return merged
end

return options
