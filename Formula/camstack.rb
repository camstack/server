class Camstack < Formula
  desc "Self-hosted camera platform with distributed agent pipeline"
  homepage "https://github.com/camstack/camstack-server"
  license "MIT"
  version "0.2.0"

  on_macos do
    on_arm do
      url "https://github.com/camstack/camstack-server/releases/download/v#{version}/camstack-v#{version}-darwin-arm64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/camstack/camstack-server/releases/download/v#{version}/camstack-v#{version}-linux-x64.tar.gz"
      sha256 "PLACEHOLDER"
    end
  end

  def install
    libexec.install Dir["*"]
    bin.install_symlink libexec/"bin/camstack"
  end

  def caveats
    <<~EOS
      Quick start:

        # Start as hub (full server)
        camstack serve

        # Start as agent (worker node)
        camstack agent --hub <HUB_IP> --token <TOKEN>

        # Check dependencies
        camstack setup

      For ML detection, install Python 3.10+ with your preferred runtime.
      For video decode/transcode, install ffmpeg:
        brew install ffmpeg
    EOS
  end

  service do
    run [opt_bin/"camstack", "serve"]
    keep_alive true
    log_path var/"log/camstack.log"
    error_log_path var/"log/camstack-error.log"
    working_dir var/"lib/camstack"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/camstack --version")
  end
end
