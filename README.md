# @steggy example repository

This is a minimal example repository, intended as a proof of concept that lives outside the [primary monorepo](https://github.com/mp3three/steggy).

## Try it out

### Install

```bash
git clone https://github.com/mp3three/quickscript.git
cd ./quickscript
yarn
```

### Run dev server

Default operation of the script will pull up a menu that:

- show a listing of fonts included with [figlet](https://github.com/patorjk/figlet.js/) library
- show an example of the string parsing capabilities of [chrono](https://github.com/wanasit/chrono)

```bash
# launch
yarn start

# skip menu, just show fonts
yarn start --fonts

# show all switches
yarn start --help
```

### Build and run

```bash
# build code
yarn build
# will accept switches, same as above
node dist/src/main.js
```

### Local Testing

Inside of `package.json`, the `bin` entry can be used to define commands to make available on the command line.
Below will build code, and install it inside the repo as a new command.

Since the command is only being installed locally, it must be be prefixed with `yarn` or `npx` to run.
If installed globally the prefix can be omitted.

```bash
yarn build
yarn add ./
npx quickscript-example
```

## Setup

### Installing Node

`@steggy` targets node16+, with node18 being preferred.
If you do not have it installed, [fnm](https://github.com/Schniz/fnm) can do that for you.

### Upgrading dependencies

All versions of `@steggy/*` should match. The command `yarn steggy` will upgrade everything to latest.

### Configuration

The script will accept configurations from:

- command line switches
- environment variables ([commentary](https://github.com/mp3three/steggy/blob/main/libs/boilerplate/src/services/auto-config.service.ts#L219))
- file based configurations

The file based configurations are great for long term peristent configurations.
The recommended location for these files is `~/.config/{app-name}`, in ini format. [All paths](https://github.com/mp3three/steggy/blob/main/libs/boilerplate/src/services/workspace.service.ts#L44)

Code that utilizes the `@steggy` bootstrap process can be utilized with the [config builder](https://www.npmjs.com/package/@steggy/config-builder), and will always support the `--scan-config` switch.

```bash
# scan through the declared configurations in the application
my_script --scan-config > ./config.json

# pull up a settings screen, based on configurations
# will only save configurations to standard / well known locations
npx config-builder --definition_file ./config.json

# work with a specific config file
npx config-builder --definition_file ./config.json --config_file ./app-configuration.yaml

# launch app using a specific configuration file
my_script --config ./app-configuration.yaml
```

## Bug reports & issues

Issues with `@steggy` libraries should be opened against the primary monorepo
