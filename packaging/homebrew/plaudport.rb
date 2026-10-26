class Plaudport < Formula
  desc "Import shared Plaud meetings and local recordings into your Plaud workspace"
  homepage "https://github.com/rwxford/plaudport"
  url "https://github.com/rwxford/plaudport/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_TARBALL_SHA256" # scripts/release.sh prints this
  license "MIT"
  version "0.1.0"

  depends_on "node"

  def install
    # A personal tap may use the network at install time, so fetch the exact
    # dependencies for this machine (tsx/esbuild ship per-arch native binaries,
    # which is why a prebuilt node_modules can't be shipped cross-platform).
    system "npm", "ci"
    libexec.install Dir["*"]
    (bin/"plaudport").write <<~SH
      #!/bin/bash
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/plaudport.mjs" "$@"
    SH
  end

  def caveats
    <<~EOS
      PlaudPort writes its archive and credentials relative to the directory you
      run it in (./data and .env), and on macOS also uses the Chrome credential
      store under ~/Library/Application Support/PlaudPort.

      Get started:
        plaudport web            # open the local web page, paste a share link
        plaudport chrome-install # optional: auto-sync the Plaud token from Chrome

      If you use the Chrome credential helper, load the unpacked extension from:
        #{opt_libexec}/chrome-extension
    EOS
  end

  test do
    assert_match "PlaudPort", shell_output("#{bin}/plaudport help")
    assert_match version.to_s, shell_output("#{bin}/plaudport --version")
  end
end
