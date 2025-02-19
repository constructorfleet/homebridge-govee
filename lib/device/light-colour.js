/* jshint node: true, esversion: 10, -W014, -W033 */
/* eslint-disable new-cap */
'use strict'

module.exports = class deviceLightColour {
  constructor (platform, accessory) {
    // Set up variables from the platform
    this.colourUtils = platform.colourUtils
    this.consts = platform.consts
    this.cusChar = platform.cusChar
    this.cusServ = platform.cusServ
    this.funcs = platform.funcs
    this.hapChar = platform.api.hap.Characteristic
    this.hapErr = platform.api.hap.HapStatusError
    this.hapServ = platform.api.hap.Service
    this.cusScenes = platform.scenes
    this.lang = platform.lang
    this.log = platform.log
    this.platform = platform

    // Set up variables from the accessory
    this.accessory = accessory
    this.name = accessory.displayName
    this.minKelvin = accessory.context.minKelvin || 2000
    this.maxKelvin = accessory.context.maxKelvin || 9000
    this.model = this.accessory.context.gvModel
    this.offlineAsOff = platform.config.offlineAsOff

    // Set up custom variables for this device type
    const deviceConf = platform.deviceConf[accessory.context.gvDeviceId]
    this.alShift =
      deviceConf && deviceConf.adaptiveLightingShift
        ? deviceConf.adaptiveLightingShift
        : platform.consts.defaultValues.adaptiveLightingShift
    this.brightStep =
      deviceConf && deviceConf.brightnessStep
        ? Math.min(deviceConf.brightnessStep, 100)
        : platform.consts.defaultValues.brightnessStep
    this.enableLogging = accessory.context.enableLogging
    this.enableDebugLogging = accessory.context.enableDebugLogging
    this.log('[%s] %s %s.', this.name, 'deviceConf', JSON.stringify(deviceConf))
    this.isRGBIC = deviceConf && (deviceConf.isRGBIC || deviceConf.lightEffects)
    this.log('[%s] %s %s.', this.name, 'isRGBIC', this.isRGBIC)
    this.lightEffects =
        this.isRGBIC
        ? deviceConf.lightEffects
        : {}
    this.log('[%s] %s %s.', this.name, 'lightEffects', deviceConf.lightEffects)

    // Add the main lightbulb service if it doesn't already exist
    this.service =
      this.accessory.getService(this.hapServ.Lightbulb) ||
      this.accessory.addService(this.hapServ.Lightbulb)

    // If adaptive lighting has just been disabled then remove and re-add service to hide AL icon
    if (this.alShift === -1 && this.accessory.context.adaptiveLighting) {
      this.accessory.removeService(this.service)
      this.service = this.accessory.addService(this.hapServ.Lightbulb)
      this.accessory.context.adaptiveLighting = false
    }

    // Add the set handler to the lightbulb on/off characteristic
    this.service.getCharacteristic(this.hapChar.On).onSet(async value => {
      await this.internalStateUpdate(value)
    })
    this.cacheState = this.service.getCharacteristic(this.hapChar.On).value ? 'on' : 'off'

    // Add the set handler to the lightbulb brightness characteristic
    this.service
      .getCharacteristic(this.hapChar.Brightness)
      .setProps({ minStep: this.brightStep })
      .onSet(async value => {
        await this.internalBrightnessUpdate(value)
      })
    this.cacheBright = this.service.getCharacteristic(this.hapChar.Brightness).value
    this.cacheBrightRaw = this.cacheBright

    // Add the set handler to the lightbulb hue characteristic
    this.service.getCharacteristic(this.hapChar.Hue).onSet(async value => {
      await this.internalColourUpdate(value)
    })
    this.cacheHue = this.service.getCharacteristic(this.hapChar.Hue).value

    // Add the set handler to the lightbulb cct characteristic
    this.service.getCharacteristic(this.hapChar.ColorTemperature).onSet(async value => {
      await this.internalCTUpdate(value)
    })
    this.cacheMired = this.service.getCharacteristic(this.hapChar.ColorTemperature).value

    // Set up the adaptive lighting controller if not disabled by user
    if (this.alShift !== -1) {
      this.alController = new platform.api.hap.AdaptiveLightingController(this.service, {
        customTemperatureAdjustment: this.alShift
      })
      this.accessory.configureController(this.alController)
      this.accessory.context.adaptiveLighting = true
    }

    this.accessory.context.effectServices = {}
    this.accessory.context.links = this.accessory.context.links || {}
    if (Object.keys(this.lightEffects).length !== 0) {
      this.log('[%s] %s %s.', this.name, 'Adding switches', this.lightEffects)
      const masterDevice = this.accessory.context.device
      for(const [effectKey, effectData] of Object.entries(this.platform.scenes)) {
        let effectEnabled = this.lightEffects[effectKey] || false
        if (!effectEnabled) {
          if (this.accessory.context.links[effectKey]) {
            let effectAccessory = this.platform.getDeviceByUUID(this.accessory.context.links.pop(effectKey))
            this.platform.removeAccessory(effectAccessory)
          }
          continue
        }
        let effectDevice = {
          device: masterDevice.device + "." + effectKey,
          model: masterDevice.model + " " + effectData.label + " effect",
          deviceName: masterDevice.deviceName + " " + effectData.label + " effect",
          linkedDevice: this.accessory.UUID
        }
        let effectAccessory = this.platform.getDeviceByUUID(this.accessory.context.links[effectKey]) || this.platform.addAccessory(effectDevice)
        let switchService = (effectAccessory.getService(this.hapServ.Switch) ||
            effectAccessory.addService(this.hapServ.Switch))
        if (!switchService.testCharacteristic(this.cusChar.EffectKey)) {
          switchService
              .addOptionalCharacteristic(this.cusChar.EffectKey)
        }
        switchService
            .updateCharacteristic(this.cusChar.EffectKey, effectKey)
        switchService
            .getCharacteristic(this.hapChar.On)
            .onSet(async value => {
              await this.internalEffectUpdate(effectKey, effectData.command, value)
            })
            .updateValue(false)
        this.accessory.context.effectServices[effectKey] = switchService
        this.accessory.context.links[effectKey] = effectAccessory.UUID
      }
    }

    // Setup custom characteristics for different scenes and modes
    this.sceneChars = []
    this.usedCodes = []
    if (deviceConf) {
      ;[
        'diyMode',
        'diyModeTwo',
        'diyModeThree',
        'diyModeFour',
        'musicMode',
        'musicModeTwo',
        'scene',
        'sceneTwo',
        'sceneThree',
        'sceneFour',
        'segmented',
        'segmentedTwo',
        'segmentedThree',
        'segmentedFour'
      ].forEach(scene => {
        const firstChar = scene.charAt()
        const charName = firstChar.toUpperCase() + scene.slice(1)

        // Check if any code has been entered in the config by the user
        if (deviceConf[scene]) {
          // Check the code is potentially valid and the corresponding connection is enabled
          const codeFirstChar = deviceConf[scene].charAt()
          if (
            (codeFirstChar === '0' && accessory.context.useBLEControl) ||
            (['M', 'o'].includes(codeFirstChar) && accessory.context.useAWSControl)
          ) {
            // Add the characteristic if not already
            if (!this.service.testCharacteristic(this.cusChar[charName])) {
              this.service.addCharacteristic(this.cusChar[charName])
            }

            // Add to the global enabled scenes list
            this.sceneChars.push(this.cusChar[charName])
            this.usedCodes.push(deviceConf[scene])

            // Add the set handler and also mark all as off when initialising accessory
            this.service
              .getCharacteristic(this.cusChar[charName])
              .onSet(async value => {
                await this.internalSceneUpdate(charName, deviceConf[scene], value)
              })
              .updateValue(false)

            // Return now so we don't hit the code below for removing the characteristic
            return
          }
        }

        // If here then either not set up or code is invalid or connection method not enabled
        if (this.service.testCharacteristic(this.cusChar[charName])) {
          this.service.removeCharacteristic(this.service.getCharacteristic(this.cusChar[charName]))
        }
      })
    }

    // Add the colour mode characteristic if at least one other scene/mode is exposed
    if (this.sceneChars.length > 0) {
      // Add the colour mode characterstic if not already
      if (!this.service.testCharacteristic(this.cusChar.ColourMode)) {
        this.service.addCharacteristic(this.cusChar.ColourMode)
      }

      // Add the colour mode to the global scene list
      this.sceneChars.push(this.cusChar.ColourMode)

      // Add the set handler and also mark as off when initialising accessory
      this.service
        .getCharacteristic(this.cusChar.ColourMode)
        .onSet(async value => {
          if (value) {
            await this.internalColourUpdate(this.cacheHue, true)
          }
        })
        .updateValue(false)
    } else {
      // Remove the characteristic if it exists already (no need for it)
      if (this.service.testCharacteristic(this.cusChar.ColourMode)) {
        this.service.removeCharacteristic(this.service.getCharacteristic(this.cusChar.ColourMode))
      }
    }

    // Add a notice about some models which may use different AWS values
    if (
      accessory.context.useAWSControl &&
      !this.consts.noScaleAWSBrightness.includes(accessory.context.gvModel)
    ) {
      this.log('[%s] %s [%s].', this.name, this.lang.noticeAWS, accessory.context.gvModel)
    }

    // Output the customised options to the log
    const opts = JSON.stringify({
      adaptiveLightingShift: this.alShift,
      brightnessStep: this.brightStep,
      disableAWS: accessory.context.hasAWSControl
        ? accessory.context.useAWSControl
          ? 'no'
          : 'yes'
        : 'unsupported',
      enableBT: accessory.context.hasBLEControl
        ? accessory.context.useBLEControl
          ? 'yes'
          : 'no'
        : 'unsupported',
      logging: this.enableDebugLogging ? 'debug' : this.enableLogging ? 'standard' : 'disable'
    })
    this.log('[%s] %s %s.', this.name, this.lang.devInitOpts, opts)
  }

  async internalStateUpdate (value) {
    try {
      // Await slightly longer than brightness and colour so on/off is sent last
      await this.funcs.sleep(500)

      const newValue = value ? 'on' : 'off'

      // Don't continue if the new value is the same as before
      if (newValue === this.cacheState) {
        return
      }

      // Don't continue if the device doesn't support this command
      if (
        this.accessory.context.supportedCmds &&
        !this.accessory.context.supportedCmds.includes('turn')
      ) {
        const eText = this.model + this.lang.notSuppTurn
        throw new Error(eText)
      }

      // Log a message in debug if the device is not currently controllable
      if (!this.cacheOnline && this.enableDebugLogging) {
        this.log('[%s] %s.', this.name, this.lang.devNotControl)
      }

      // Set up a one minute timeout for the plugin to ignore incoming updates
      const timerKey = this.funcs.generateRandomString(5)
      this.updateTimeoutAPI = timerKey
      setTimeout(() => {
        if (this.updateTimeoutAPI === timerKey) {
          this.updateTimeoutAPI = false
        }
      }, 60000)

      // Send the request to the platform sender function
      await this.platform.sendDeviceUpdate(this.accessory, {
        cmd: 'state',
        value: newValue
      })

      // Cache the new state and log if appropriate
      if (this.cacheState !== newValue) {
        this.cacheState = newValue
        if (this.enableLogging) {
          this.log('[%s] %s [%s].', this.name, this.lang.curState, this.cacheState)
        }
      }
    } catch (err) {
      // Catch any errors during the process
      const eText = this.funcs.parseError(err)
      this.log.warn(
        '[%s] %s %s.',
        this.name,
        this.lang.devNotUpdated,
        eText.includes('p-queue') ? this.lang.timeout : eText
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.On, this.cacheState === 'on')
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async internalBrightnessUpdate (value) {
    try {
      // This acts like a debounce function when endlessly sliding the brightness scale
      const updateKeyBright = this.funcs.generateRandomString(5)
      this.updateKeyBright = updateKeyBright
      await this.funcs.sleep(400)
      if (updateKeyBright !== this.updateKeyBright) {
        return
      }

      // Don't continue if the new value is the same as before
      if (value === this.cacheBright) {
        return
      }

      // Don't continue if the device doesn't support this command
      if (
        this.accessory.context.supportedCmds &&
        !this.accessory.context.supportedCmds.includes('brightness')
      ) {
        const eText = this.model + this.lang.notSuppBrightness
        throw new Error(eText)
      }

      // Log a message in debug if the device is not currently controllable
      if (!this.cacheOnline && this.enableDebugLogging) {
        this.log('[%s] %s.', this.name, this.lang.devNotControl)
      }

      // Set up a one minute timeout for the plugin to ignore incoming updates
      this.updateTimeoutAPI = updateKeyBright
      setTimeout(() => {
        if (this.updateTimeoutAPI === updateKeyBright) {
          this.updateTimeoutAPI = false
        }
      }, 60000)

      // Send the request to the platform sender function
      await this.platform.sendDeviceUpdate(this.accessory, {
        cmd: 'brightness',
        value
      })

      // Govee considers 0% brightness to be off
      if (value === 0) {
        setTimeout(() => {
          this.cacheState = 'off'
          if (this.service.getCharacteristic(this.hapChar.On).value) {
            this.service.updateCharacteristic(this.hapChar.On, false)
            if (this.enableLogging) {
              this.log('[%s] %s [%s].', this.name, this.lang.curState, this.cacheState)
            }
          }
          this.service.updateCharacteristic(this.hapChar.Brightness, this.cacheBright)
        }, 1500)
        return
      }

      // Cache the new state and log if appropriate
      if (this.cacheBright !== value) {
        this.cacheBright = value
        if (this.enableLogging) {
          this.log('[%s] %s [%s%].', this.name, this.lang.curBright, value)
        }
      }
    } catch (err) {
      // Catch any errors during the process
      const eText = this.funcs.parseError(err)
      this.log.warn(
        '[%s] %s %s.',
        this.name,
        this.lang.devNotUpdated,
        eText.includes('p-queue') ? this.lang.timeout : eText
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.Brightness, this.cacheBright)
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async internalColourUpdate (value, force = false) {
    try {
      // This acts like a debounce function when endlessly sliding the colour wheel
      const updateKeyColour = this.funcs.generateRandomString(5)
      this.updateKeyColour = updateKeyColour
      await this.funcs.sleep(300)
      if (updateKeyColour !== this.updateKeyColour) {
        return
      }

      // Updating the cct to the lowest value mimics native adaptive lighting
      this.service.updateCharacteristic(this.hapChar.ColorTemperature, 140)

      // Don't continue if the new value is the same as before
      const currentSat = this.service.getCharacteristic(this.hapChar.Saturation).value
      const newRGB = this.colourUtils.hs2rgb(value, currentSat)
      if (
        !force &&
        newRGB[0] === this.cacheR &&
        newRGB[1] === this.cacheG &&
        newRGB[2] === this.cacheB
      ) {
        return
      }

      // Don't continue if the device doesn't support this command
      if (
        this.accessory.context.supportedCmds &&
        !this.accessory.context.supportedCmds.includes('color')
      ) {
        const eText = this.model + this.lang.notSuppColour
        throw new Error(eText)
      }

      // Log a message in debug if the device is not currently controllable
      if (!this.cacheOnline && this.enableDebugLogging) {
        this.log('[%s] %s.', this.name, this.lang.devNotControl)
      }

      // Set up a one minute timeout for the plugin to ignore incoming updates
      this.updateTimeoutAPI = updateKeyColour
      setTimeout(() => {
        if (this.updateTimeoutAPI === updateKeyColour) {
          this.updateTimeoutAPI = false
        }
      }, 60000)

      // Send the request to the platform sender function
      await this.platform.sendDeviceUpdate(this.accessory, {
        cmd: 'color',
        value: {
          r: newRGB[0],
          g: newRGB[1],
          b: newRGB[2]
        }
      })

      // Switch off any custom mode/scene characteristics and turn the on switch to on
      setTimeout(() => {
        this.sceneChars.forEach(char => this.service.updateCharacteristic(char, false))
        this.service.updateCharacteristic(this.hapChar.On, true)
      }, 3000)

      // Cache the new state and log if appropriate
      this.cacheHue = value
      this.cacheKelvin = 0
      if (this.cacheR !== newRGB[0] || this.cacheG !== newRGB[1] || this.cacheB !== newRGB[2]) {
        this.cacheR = newRGB[0]
        this.cacheG = newRGB[1]
        this.cacheB = newRGB[2]
        if (this.enableLogging) {
          this.log(
            '[%s] %s [rgb %s].',
            this.name,
            this.lang.curColour,
            this.cacheR + ' ' + this.cacheG + ' ' + this.cacheB
          )
        }
      }
    } catch (err) {
      // Catch any errors during the process
      const eText = this.funcs.parseError(err)
      this.log.warn(
        '[%s] %s %s.',
        this.name,
        this.lang.devNotUpdated,
        eText.includes('p-queue') ? this.lang.timeout : eText
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.Hue, this.cacheHue)
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async internalCTUpdate (value) {
    try {
      // This acts like a debounce function when endlessly sliding the colour wheel
      const updateKeyCT = this.funcs.generateRandomString(5)
      this.updateKeyCT = updateKeyCT
      await this.funcs.sleep(300)
      if (updateKeyCT !== this.updateKeyCT) {
        return
      }

      // Convert mired to kelvin to nearest 100 (Govee seems to need this)
      const kelvin = Math.round(1000000 / value / 100) * 100

      // Check and increase/decrease kelvin to range of device
      const k = Math.min(Math.max(kelvin, this.minKelvin), this.maxKelvin)

      // Don't continue if the new value is the same as before
      if (this.cacheState !== 'on' || this.cacheKelvin === k) {
        if (
          this.alController &&
          this.alController.isAdaptiveLightingActive() &&
          this.enableDebugLogging
        ) {
          this.log('[%s] %s [%sK / %sM].', this.name, this.lang.skippingAL, k, value)
        }
        return
      }

      // Updating the hue/sat to the corresponding values mimics native adaptive lighting
      const hs = this.colourUtils.m2hs(value)
      this.service.updateCharacteristic(this.hapChar.Hue, hs[0])
      this.service.updateCharacteristic(this.hapChar.Saturation, hs[1])

      // Don't continue if the device doesn't support this command
      if (
        this.accessory.context.supportedCmds &&
        !this.accessory.context.supportedCmds.includes('color')
      ) {
        const eText = this.model + this.lang.notSuppColour
        throw new Error(eText)
      }

      // Log a message in debug if the device is not currently controllable
      if (!this.cacheOnline && this.enableDebugLogging) {
        this.log('[%s] %s.', this.name, this.lang.devNotControl)
      }

      // Set up a one minute timeout for the plugin to ignore incoming updates
      this.updateTimeoutAPI = updateKeyCT
      this.updateTimeoutAWS = updateKeyCT
      setTimeout(() => {
        if (this.updateTimeoutAPI === updateKeyCT) {
          this.updateTimeoutAPI = false
        }
      }, 60000)
      setTimeout(() => {
        if (this.updateTimeoutAWS === updateKeyCT) {
          this.updateTimeoutAPI = false
        }
      }, 5000)

      // Convert kelvin to rgb to use in case device doesn't support colour temperature
      const rgb = this.colourUtils.k2rgb(k)

      // Set up the params object to send
      const objToSend = {}

      // If the device supports colour temperature then send colorTem
      if (
        this.accessory.context.supportedCmds &&
        this.accessory.context.supportedCmds.includes('colorTem')
      ) {
        // Send kelvin value
        objToSend.cmd = 'colorTem'
        objToSend.value = k
      } else {
        // Send rgb values
        objToSend.cmd = 'color'
        objToSend.value = { r: rgb[0], g: rgb[1], b: rgb[2] }
      }

      // Send the request to the platform sender function
      await this.platform.sendDeviceUpdate(this.accessory, objToSend)

      // Cache the new state and log if appropriate
      this.cacheR = rgb[0]
      this.cacheG = rgb[1]
      this.cacheB = rgb[2]
      this.cacheMired = value
      if (this.cacheKelvin !== k) {
        this.cacheKelvin = k
        if (this.enableLogging) {
          if (this.alController && this.alController.isAdaptiveLightingActive()) {
            this.log(
              '[%s] %s [%sK / %sM] %s.',
              this.name,
              this.lang.curColour,
              k,
              value,
              this.lang.viaAL
            )
          } else {
            this.log('[%s] %s [%sK / %sM].', this.name, this.lang.curColour, k, value)
          }
        }
      }
    } catch (err) {
      // Catch any errors during the process
      const eText = this.funcs.parseError(err)
      this.log.warn(
        '[%s] %s %s.',
        this.name,
        this.lang.devNotUpdated,
        eText.includes('p-queue') ? this.lang.timeout : eText
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        this.service.updateCharacteristic(this.hapChar.ColorTemperature, this.cacheMired)
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async _enableColorMode() {
    if (this.alController && this.alController.isAdaptiveLightingActive()) {
      this.alController.enableAdaptiveLighting()
      if (this.enableLogging) {
        this.log('[%s] %s.', this.name, this.lang.alDisabled)
      }
    }
    await this.platform.sendDeviceUpdate(this.accessory, {
      cmd: 'scene',
      command: this.platform.scenes.colorMode.command
    })
  }

  async _enableScene(command) {
    // Disable adaptive lighting if it's on already
    if (this.alController && this.alController.isAdaptiveLightingActive()) {
      this.alController.disableAdaptiveLighting()
      if (this.enableLogging) {
        this.log('[%s] %s.', this.name, this.lang.alDisabled)
      }
    }
    await this.platform.sendDeviceUpdate(this.accessory, {
      cmd: 'scene',
      command: command
    })
  }

  async internalEffectUpdate(key, command, value) {
    try {
      if (!value) {
        await this._enableColorMode()
      } else {
        await this._enableScene(command)
      }
      this.accessory.context.effectServices[key].updateCharacteristic(this.hapChar.On, value)

    } catch (err) {
      // Catch any errors during the process
      const eText = this.funcs.parseError(err)
      this.log.warn('[%s] %s %s.', this.name, this.lang.devNotUpdated, eText)

      // // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      // setTimeout(() => {
      //   this.accessory.updateCharacteristic(this.cusChar[charName], false)
      // }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  async internalSceneUpdate (charName, code, value) {
    try {
      // Don't continue if command is to turn off - they are stateless buttons
      if (!value) {
        return
      }

      // Send the request to the platform sender function
      await this.platform.sendDeviceUpdate(this.accessory, {
        cmd: 'scene',
        value: code
      })

      // Disable adaptive lighting if it's on already
      if (this.alController && this.alController.isAdaptiveLightingActive()) {
        this.alController.disableAdaptiveLighting()
        if (this.enableLogging) {
          this.log('[%s] %s.', this.name, this.lang.alDisabled)
        }
      }

      // Log the scene change
      this.log('[%s] %s [%s].', this.name, this.lang.curScene, charName)

      // Turn all the characteristics off and turn the on switch to on
      setTimeout(() => {
        this.sceneChars.forEach(char => this.service.updateCharacteristic(char, false))
        this.service.updateCharacteristic(this.hapChar.On, true)
      }, 3000)
    } catch (err) {
      // Catch any errors during the process
      const eText = this.funcs.parseError(err)
      this.log.warn(
        '[%s] %s %s.',
        this.name,
        this.lang.devNotUpdated,
        eText.includes('p-queue') ? this.lang.timeout : eText
      )

      // Throw a 'no response' error and set a timeout to revert this after 2 seconds
      setTimeout(() => {
        this.service.updateCharacteristic(this.cusChar[charName], false)
      }, 2000)
      throw new this.hapErr(-70402)
    }
  }

  externalUpdate (params) {
    // Don't apply the update during the one minute timeout if update is from API
    if (
      (this.updateTimeoutAPI && params.source === 'API') ||
      (this.updateTimeoutAWS && params.source === 'AWS')
    ) {
      return
    }

    if (params.source === 'AWS') {
      // Set up a one minute timeout for the plugin to ignore incoming updates if update is from AWS
      // API can take a while to update from changes, so always go with the AWS update
      const updateKey = this.funcs.generateRandomString(5)
      this.updateTimeoutAPI = updateKey
      setTimeout(() => {
        if (this.updateTimeoutAPI === updateKey) {
          this.updateTimeoutAPI = false
        }
      }, 60000)
    }

    // Check to see if the provided online status is different from the cache value
    if (this.funcs.hasProperty(params, 'online') && this.cacheOnline !== params.online) {
      this.cacheOnline = params.online
      this.platform.updateAccessoryStatus(this.accessory, this.cacheOnline)
    }

    // If offline and user enabled offlineAsOff, then mark accessory as off
    if (!this.cacheOnline && this.offlineAsOff) {
      params.state = 'off'
    }

    // Check to see if the provided state is different from the cached value
    if (params.state && params.state !== this.cacheState) {
      // State is different so update Homebridge with new values
      this.cacheState = params.state
      this.service.updateCharacteristic(this.hapChar.On, this.cacheState === 'on')

      // Log the change if appropriate
      if (this.enableLogging) {
        this.log('[%s] %s [%s].', this.name, this.lang.curState, this.cacheState)
      }
    }

    // Check to see if the provided brightness is different from the cached value
    if (this.funcs.hasProperty(params, 'brightness') && params.brightness !== this.cacheBrightRaw) {
      // Brightness is different so update Homebridge with new values
      this.cacheBrightRaw = params.brightness

      // Govee considers brightness 0 as OFF so change brightness to 1 if light is on
      this.cacheBright =
        this.cacheState === 'on' ? Math.max(this.cacheBrightRaw, 1) : this.cacheBrightRaw
      this.service.updateCharacteristic(this.hapChar.Brightness, this.cacheBright)

      // Log the change if appropriate
      if (this.enableLogging) {
        this.log('[%s] %s [%s%].', this.name, this.lang.curBright, this.cacheBright)
      }
    }

    // Check to see if the provided colour is different from the cached state
    if (params.kelvin || params.rgb) {
      // Colour can be provided in rgb or kelvin so either way convert to hs for later
      let hs
      let rgb
      let mired
      if (params.kelvin) {
        mired = Math.round(1000000 / params.kelvin)
        hs = this.colourUtils.m2hs(mired)
        rgb = this.colourUtils.hs2rgb(hs[0], hs[1])
      } else {
        rgb = [params.rgb.r, params.rgb.g, params.rgb.b]
        hs = this.colourUtils.rgb2hs(rgb[0], rgb[1], rgb[2])
      }

      // Perform the check against the cache
      if (hs[0] !== this.cacheHue) {
        // Check for a difference in rgb values for adaptive lighting used later
        const rgbDiff =
          Math.abs(rgb[0] - this.cacheR) +
          Math.abs(rgb[1] - this.cacheG) +
          Math.abs(rgb[2] - this.cacheB)

        // Colour is different so update Homebridge with new values
        this.service.updateCharacteristic(this.hapChar.Hue, hs[0])
        this.service.updateCharacteristic(this.hapChar.Saturation, hs[1])
        this.cacheR = rgb[0]
        this.cacheG = rgb[1]
        this.cacheB = rgb[2]
        this.cacheHue = hs[0]

        if (mired) {
          this.service.updateCharacteristic(this.hapChar.ColorTemperature, mired)
          this.cacheMired = mired
        }

        // Log the change if appropriate
        if (this.enableLogging) {
          if (mired) {
            this.log('[%s] %s [%sK / %sM].', this.name, this.lang.curColour, params.kelvin, mired)
          } else {
            this.log(
              '[%s] %s [rgb %s].',
              this.name,
              this.lang.curColour,
              this.cacheR + ' ' + this.cacheG + ' ' + this.cacheB
            )
          }
        }

        // If the difference is significant (>50) then disable adaptive lighting
        if (this.alController && this.alController.isAdaptiveLightingActive() && rgbDiff > 50) {
          this.alController.disableAdaptiveLighting()
          if (this.enableLogging) {
            this.log('[%s] %s.', this.name, this.lang.alDisabled)
          }
        }
      }
    }
    if (params.scene) {
      // Disable adaptive lighting
      if (this.alController && this.alController.isAdaptiveLightingActive()) {
        this.alController.disableAdaptiveLighting()
        if (this.enableLogging) {
          this.log('[%s] %s.', this.name, this.lang.alDisabled)
        }
      }
      const fullCode = params.scene + '||' + params.cmd + '||' + params.prop
      if (this.enableDebugLogging && !this.usedCodes.includes(fullCode)) {
        this.log.warn('[%s] %s:\n%s', this.name, this.lang.sceneCode, fullCode)
      }
    }

    if (params.command) {
      let allOff = true
      for (const [effectKey, effectService] of Object.entries(this.accessory.context.effectServices)) {
        let effectCommand = JSON.stringify(this.platform.scenes[effectKey].command)
        let value = (params.command === effectCommand)
        effectService.updateCharacteristic(this.hapChar.On, value)
        if (value) {
          allOff = false
        }
      }

      if (allOff) {
        // TODO : Color Mode
      }
    }

    // Update the variable that the first run has completed
    this.firstUpdateDone = true
  }
}
