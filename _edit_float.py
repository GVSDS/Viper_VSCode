path = r'd:\Users\TermiNexus\Desktop\Viper_VSCode\packages\vipeye-internal\src\analyzer\types.ts'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

old1 = (
    "// Viper \u6269\u5c55\uff1aViper C \u6d6e\u70b9\u7c7b\u578b\u540d\u79f0\u767d\u540d\u5355\u3002\n"
    "const _viperCFloatTypeNames = new Set<string>([\n"
    "    'CFloat', 'CDouble', 'CFloat8T', 'CFloat16T', 'CFloat32T', 'CFloat64T', 'CFloat128T',\n"
    "]);\n"
)

new1 = old1 + (
    "\n"
    "// Viper \u6269\u5c55\uff1a\u5224\u65ad\u7c7b\u578b\u540d\u662f\u5426\u4e3a Viper C \u6d6e\u70b9\u7c7b\u578b\u3002\n"
    "// \u7528\u4e8e\u534f\u8bae\u5339\u914d\u7b49\u573a\u666f\uff0c\u8ba9 CType \u6d6e\u70b9\u5b50\u7c7b\u6ee1\u8db3 SupportsFloat \u7b49\u6570\u503c\u534f\u8bae\u3002\n"
    "export function isViperCFloatTypeName(name: string): boolean {\n"
    "    return _viperCFloatTypeNames.has(name);\n"
    "}\n"
)

c1 = text.count(old1)
print('Edit1 match count:', c1)
assert c1 == 1, f'Edit1 match count: {c1}'
text = text.replace(old1, new1)

with open(path, 'w', encoding='utf-8') as f:
    f.write(text)

print('isViperCFloatTypeName function added.')
