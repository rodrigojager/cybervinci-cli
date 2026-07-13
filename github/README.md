# CYBERVINCI GitHub Action

This composite action runs a CYBERVINCI binary supplied by the caller. It never downloads OpenCode or any other executable.

## Requirements

- Build or obtain a trusted CYBERVINCI binary in an earlier workflow step.
- Pass its path through the required binary input.
- Configure a model and credentials. OpenCode service credentials such as OPENCODE_API_KEY keep their official names.

## Local repository example

    - uses: actions/checkout@v4

    - name: Build CYBERVINCI
      run: bun run --cwd packages/cybervinci script/build.ts --single --skip-install --skip-embed-web-ui

    - name: Run CYBERVINCI
      uses: ./github
      with:
        binary: ./packages/cybervinci/dist/cybervinci-linux-x64/bin/cybervinci
        model: opencode/claude-opus-4-5
        use_github_token: true

The action has no default release feed. Set oidc_base_url only when a trusted app-token exchange service has been configured, or use use_github_token.