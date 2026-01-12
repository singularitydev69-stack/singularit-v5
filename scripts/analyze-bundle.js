const fs = require("fs");

// Check if we should save to file
const saveToFile = process.argv.includes("--save") || process.argv.includes("-save");

function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

function analyzeMetafile(metaPath, bundleName) {
    if (!fs.existsSync(metaPath)) {
        return `\n${bundleName}: Metafile not found (Run 'npm run build:analyze' first)\n`;
    }

    const metafile = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    let output = "";

    output += `\n${"=".repeat(80)}\n`;
    output += `${bundleName}\n`;
    output += `${"=".repeat(80)}\n\n`;

    // Analyze inputs
    const inputs = Object.entries(metafile.inputs)
        .map(([path, info]) => ({ path, bytes: info.bytes }))
        .sort((a, b) => b.bytes - a.bytes);

    const totalInputBytes = inputs.reduce((sum, i) => sum + i.bytes, 0);

    // Get outputs
    const outputs = Object.entries(metafile.outputs);
    const mainOutput = outputs.find(([_, info]) => info.entryPoint) || outputs[0];
    const outputBytes = mainOutput ? mainOutput[1].bytes : 0;

    output += `Summary:\n`;
    output += `  Total Input:  ${formatBytes(totalInputBytes)}\n`;
    output += `  Bundle Size:  ${formatBytes(outputBytes)}\n`;
    const compression = totalInputBytes > 0 ? ((outputBytes / totalInputBytes) * 100).toFixed(1) + "%" : "0.0%";
    output += `  Compression:  ${compression}\n\n`;

    output += `Top 100 Largest Modules:\n`;
    output += `${"─".repeat(80)}\n`;

    inputs.slice(0, 100).forEach((item, idx) => {
        const percentage = ((item.bytes / totalInputBytes) * 100).toFixed(1);
        const sizeStr = formatBytes(item.bytes).padEnd(12);
        const pctStr = `${percentage}%`.padEnd(7);

        // Try to get line count
        let linesStr = "      ";
        try {
            if (fs.existsSync(item.path)) {
                const content = fs.readFileSync(item.path, "utf8");
                const lines = content.split("\n").length;
                linesStr = `${lines}L`.padEnd(6);
            }
        } catch (e) {
            // ignore errors
        }

        // Shorten path for readability
        let displayPath = item.path;
        if (displayPath.includes("node_modules")) {
            const parts = displayPath.split("node_modules/");
            displayPath = parts[parts.length - 1];
        } else if (displayPath.includes("ui/")) {
            displayPath = displayPath.substring(displayPath.indexOf("ui/"));
        } else if (displayPath.includes("src/")) {
            displayPath = displayPath.substring(displayPath.indexOf("src/"));
        }

        output += `${(idx + 1).toString().padStart(3)}. ${sizeStr} ${linesStr} (${pctStr}) ${displayPath}\n`;
    });

    // Find packages
    const pkgs = {};
    inputs.forEach((item) => {
        const match = item.path.match(/node_modules\/(@?[^\/]+(?:\/[^\/]+)?)/);
        if (match) {
            const pkg = match[1];
            if (!pkgs[pkg]) pkgs[pkg] = 0;
            pkgs[pkg] += item.bytes;
        }
    });

    const largestPkgs = Object.entries(pkgs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);

    if (largestPkgs.length > 0) {
        output += `\nTop 15 Heaviest Packages:\n`;
        output += `${"─".repeat(80)}\n`;
        largestPkgs.forEach(([pkg, bytes], idx) => {
            const sizeStr = formatBytes(bytes).padEnd(12);
            const percentage = ((bytes / totalInputBytes) * 100).toFixed(1);
            const pctStr = `${percentage}%`.padEnd(7);

            output += `${(idx + 1).toString().padStart(3)}. ${sizeStr} (${pctStr}) ${pkg}\n`;
        });
    }

    return output;
}

// Analyze all bundles
const bundles = [
    { file: "dist/analysis/meta-ui.json", name: "UI BUNDLE (Main Application)" },
    { file: "dist/analysis/meta-bg.json", name: "SERVICE WORKER BUNDLE" },
    { file: "dist/analysis/meta-cs-openai.json", name: "CONTENT SCRIPT BUNDLE" },
    { file: "dist/analysis/meta-offscreen.json", name: "OFFSCREEN BUNDLE" },
    { file: "dist/analysis/meta-oi.json", name: "OI BUNDLE" },
];

// Check for filter argument
const filterArg = process.argv.find(arg => !arg.startsWith("--") && !arg.includes("analyze-bundle.js") && !arg.includes("node.exe"));
const activeBundles = filterArg
    ? bundles.filter(b => b.name.toLowerCase().includes(filterArg.toLowerCase()))
    : bundles;

if (filterArg && activeBundles.length === 0) {
    console.log(`No bundles found matching filter: "${filterArg}"`);
    console.log("Available bundles:", bundles.map(b => b.name).join(", "));
    process.exit(0);
}

let fullReport = "";
fullReport += `\n${"=".repeat(80)}\n`;
fullReport += `BUNDLE SIZE ANALYSIS REPORT\n`;
fullReport += `Generated: ${new Date().toLocaleString()}\n`;
fullReport += `${"=".repeat(80)}\n`;

activeBundles.forEach((bundle) => {
    fullReport += analyzeMetafile(bundle.file, bundle.name);
});

fullReport += `\n${"=".repeat(80)}\n`;
fullReport += `RECOMMENDATIONS:\n`;
fullReport += `${"=".repeat(80)}\n`;
fullReport += `1. Focus on modules larger than 50 KB\n`;
fullReport += `2. Consider lazy loading for heavy features\n`;
fullReport += `3. Check if you're importing full libraries vs specific components\n`;
fullReport += `4. Use dynamic imports for code splitting\n`;
fullReport += `5. Review if all imported packages are actually used\n`;
fullReport += `\nFor interactive visualization: npm run analyze:ui\n`;
fullReport += `${"=".repeat(80)}\n\n`;

// Output results
if (saveToFile) {
    fs.writeFileSync("bundle-analysis-report.txt", fullReport, "utf8");
    console.log("✓ Report saved to: bundle-analysis-report.txt\n");
} else {
    console.log(fullReport);
}
