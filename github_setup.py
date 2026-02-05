import os
import json
from pathlib import Path

def find_index_html(root_path):
    """Scans the repository recursively to find index.html."""
    print(f"🔍 Scanning repository in: {root_path}")
    html_files = list(Path(root_path).rglob("index.html"))
    
    if not html_files:
        print("❌ Error: No index.html found. Cannot proceed.")
        return None
    
    # Return the first one found (or prioritize root if needed)
    target_file = html_files[0]
    print(f"✅ Found index.html at: {target_file}")
    return target_file

def detect_project_type(root_path):
    """
    Detects if this is a Node.js project or a Static HTML project
    by checking for package.json.
    """
    package_json_path = Path(root_path) / "package.json"
    
    if package_json_path.exists():
        print("📦 Detected project type: Node.js / Framework (React, Vue, etc.)")
        try:
            with open(package_json_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                # Check if build script exists
                scripts = data.get("scripts", {})
                if "build" in scripts:
                    print(f"🛠️  Build script found: npm run {scripts['build']}")
                else:
                    print("⚠️  Warning: No 'build' script found in package.json. The workflow might fail.")
        except Exception as e:
            print(f"⚠️  Could not read package.json: {e}")
        return "node"
    else:
        print("📄 Detected project type: Static HTML/CSS/JS")
        return "static"

def ensure_directory(path):
    """Creates directory if it doesn't exist."""
    Path(path).mkdir(parents=True, exist_ok=True)

def create_github_workflow(project_type, output_dir=".github/workflows"):
    """
    Generates the appropriate GitHub Actions YAML file based on project type.
    """
    ensure_directory(output_dir)
    workflow_path = Path(output_dir) / "static.yml"
    
    # Define workflows
    static_workflow = """name: Deploy static content to Pages

on:
  push:
    branches: ["main", "master"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup Pages
        uses: actions/configure-pages@v4
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          # Upload entire repository
          path: '.'
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
"""

    node_workflow = """name: Build and Deploy Node.js Project

on:
  push:
    branches: ["main", "master"]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: "pages"
  cancel-in-progress: false

jobs:
  build-and-deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18.x, 20.x]
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Use Node.js ${{ matrix.node-version }}
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: 'npm'
      - name: Install Dependencies
        run: npm ci
      - name: Build Project
        run: npm run build
      - name: Setup Pages
        uses: actions/configure-pages@v4
      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          # CHANGE THIS: If your build output is in 'build' or 'out', change './dist' below
          path: './dist'
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
"""

    content = ""
    if project_type == "node":
        content = node_workflow
        print("📝 Generating Node.js GitHub Actions workflow...")
    else:
        content = static_workflow
        print("📝 Generating Static HTML GitHub Actions workflow...")

    with open(workflow_path, 'w', encoding='utf-8') as f:
        f.write(content)
    
    print(f"✅ Workflow file created/updated at: {workflow_path}")
    
    # Advice for Node projects
    if project_type == "node":
        print("⚠️  IMPORTANT: Check the 'path' in the workflow file.")
        print("   - Vite/Svelte usually uses './dist'")
        print("   - Create React App usually uses './build'")
        print("   - Next.js (static export) usually uses './out'")

def create_nojekyll(root_path):
    """
    Creates a .nojekyll file if it doesn't exist.
    This prevents GitHub from ignoring files starting with underscores (e.g., _scss, _next).
    """
    nojekyll_path = Path(root_path) / ".nojekyll"
    if not nojekyll_path.exists():
        nojekyll_path.touch()
        print("✅ Created .nojekyll file to ensure proper file handling.")
    else:
        print("ℹ️  .nojekyll already exists.")

def main():
    # Get the directory where this script is running
    repo_root = Path.cwd()
    
    # 1. Scan and Find index.html
    index_file = find_index_html(repo_root)
    if not index_file:
        return

    # 2. Detect Type
    p_type = detect_project_type(repo_root)

    # 3. Create/Update Workflow File
    create_github_workflow(p_type)

    # 4. Create .nojekyll (Best practice)
    create_nojekyll(repo_root)
    
    print("\n" + "="*50)
    print("🚀 SETUP COMPLETE!")
    print("="*50)
    print("Next steps:")
    print("1. Review the generated file: .github/workflows/static.yml")
    print("2. Commit and push this file to your GitHub repository.")
    print("3. Go to Repository Settings -> Pages and ensure 'Source' is set to 'GitHub Actions'.")
    print("="*50)

if __name__ == "__main__":
    main()
