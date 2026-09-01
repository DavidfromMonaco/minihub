param(
    [string]$OutputPath = '',
    [switch]$RequireSingleLiveEngine,
    [switch]$RequireSingleAudioSession
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not ('MiniHub.AudioSessions' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MiniHub {
    public enum EDataFlow { Render, Capture, All }
    public enum AudioSessionState { Inactive, Active, Expired }

    [Flags]
    public enum DeviceState : uint { Active = 0x1, Disabled = 0x2, NotPresent = 0x4, Unplugged = 0x8, All = 0xF }

    [Flags]
    public enum ClsCtx : uint { InprocServer = 0x1, InprocHandler = 0x2, LocalServer = 0x4, All = 0x17 }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject {}

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    internal interface IMMDeviceEnumerator {
        [PreserveSig]
        int EnumAudioEndpoints(EDataFlow dataFlow, DeviceState stateMask, out IMMDeviceCollection devices);
        [PreserveSig]
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, int role, out IMMDevice endpoint);
        [PreserveSig]
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig]
        int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig]
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("0BD7A1BE-7A1A-44DB-8397-C0A8A3C705AF")]
    internal interface IMMDeviceCollection {
        [PreserveSig]
        int GetCount(out uint count);
        [PreserveSig]
        int Item(uint index, out IMMDevice device);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    internal interface IMMDevice {
        [PreserveSig]
        int Activate(ref Guid iid, ClsCtx clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig]
        int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig]
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig]
        int GetState(out DeviceState state);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    internal interface IAudioSessionManager2 {
        [PreserveSig]
        int GetAudioSessionControl(ref Guid sessionGuid, uint streamFlags, out IntPtr sessionControl);
        [PreserveSig]
        int GetSimpleAudioVolume(ref Guid sessionGuid, uint streamFlags, out IntPtr audioVolume);
        [PreserveSig]
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
        [PreserveSig]
        int RegisterSessionNotification(IntPtr sessionNotification);
        [PreserveSig]
        int UnregisterSessionNotification(IntPtr sessionNotification);
        [PreserveSig]
        int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
        [PreserveSig]
        int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    internal interface IAudioSessionEnumerator {
        [PreserveSig]
        int GetCount(out int count);
        [PreserveSig]
        int GetSession(int index, out IAudioSessionControl session);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    internal interface IAudioSessionControl {
        [PreserveSig]
        int GetState(out AudioSessionState state);
        [PreserveSig]
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        [PreserveSig]
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
        [PreserveSig]
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        [PreserveSig]
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
        [PreserveSig]
        int GetGroupingParam(out Guid groupingId);
        [PreserveSig]
        int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
        [PreserveSig]
        int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig]
        int UnregisterAudioSessionNotification(IntPtr client);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    internal interface IAudioSessionControl2 {
        [PreserveSig]
        int GetState(out AudioSessionState state);
        [PreserveSig]
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        [PreserveSig]
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, ref Guid eventContext);
        [PreserveSig]
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        [PreserveSig]
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, ref Guid eventContext);
        [PreserveSig]
        int GetGroupingParam(out Guid groupingId);
        [PreserveSig]
        int SetGroupingParam(ref Guid groupingId, ref Guid eventContext);
        [PreserveSig]
        int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig]
        int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig]
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionIdentifier);
        [PreserveSig]
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionInstanceIdentifier);
        [PreserveSig]
        int GetProcessId(out uint processId);
        [PreserveSig]
        int IsSystemSoundsSession();
        [PreserveSig]
        int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    public sealed class SessionRecord {
        public string EndpointId { get; set; }
        public int ProcessId { get; set; }
        public string ProcessName { get; set; }
        public string ProcessPath { get; set; }
        public string State { get; set; }
        public string DisplayName { get; set; }
        public string SessionIdentifier { get; set; }
        public string SessionInstanceIdentifier { get; set; }
    }

    public static class AudioSessions {
        private static void Release(object value) {
            if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }

        public static SessionRecord[] EnumerateRenderSessions() {
            var result = new List<SessionRecord>();
            IMMDeviceEnumerator enumerator = null;
            IMMDevice device = null;
            IAudioSessionManager2 manager = null;
            IAudioSessionEnumerator sessions = null;
            try {
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.Render, 1, out device));
                string endpointId;
                Marshal.ThrowExceptionForHR(device.GetId(out endpointId));
                var managerIid = typeof(IAudioSessionManager2).GUID;
                object activated;
                Marshal.ThrowExceptionForHR(device.Activate(ref managerIid, ClsCtx.All, IntPtr.Zero, out activated));
                manager = (IAudioSessionManager2)activated;
                Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
                int count;
                Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
                for (int sessionIndex = 0; sessionIndex < count; sessionIndex++) {
                    IAudioSessionControl control = null;
                    try {
                        Marshal.ThrowExceptionForHR(sessions.GetSession(sessionIndex, out control));
                        var control2 = (IAudioSessionControl2)control;
                        uint pid;
                        AudioSessionState state;
                        string displayName, identifier, instanceIdentifier;
                        Marshal.ThrowExceptionForHR(control2.GetProcessId(out pid));
                        Marshal.ThrowExceptionForHR(control2.GetState(out state));
                        control2.GetDisplayName(out displayName);
                        control2.GetSessionIdentifier(out identifier);
                        control2.GetSessionInstanceIdentifier(out instanceIdentifier);
                        string processName = "", processPath = "";
                        if (pid != 0) {
                            try {
                                var process = Process.GetProcessById((int)pid);
                                processName = process.ProcessName;
                                try { processPath = process.MainModule.FileName; } catch {}
                            }
                            catch {}
                        }
                        result.Add(new SessionRecord {
                            EndpointId = endpointId,
                            ProcessId = (int)pid,
                            ProcessName = processName,
                            ProcessPath = processPath,
                            State = state.ToString(),
                            DisplayName = displayName ?? "",
                            SessionIdentifier = identifier ?? "",
                            SessionInstanceIdentifier = instanceIdentifier ?? ""
                        });
                    }
                    finally { Release(control); }
                }
            }
            finally { Release(sessions); Release(manager); Release(device); Release(enumerator); }
            return result.ToArray();
        }
    }
}
'@
}

$nativeProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('MiniHub.exe', 'mlh-audio-engine.exe', 'mlh-vst3-scanner.exe')
} | Sort-Object Name, ProcessId | ForEach-Object {
    $isLegacyScanner = $_.Name -eq 'mlh-audio-engine.exe' -and $_.CommandLine -match '(?i)--scan-file(?:\s|=)'
    $role = if ($_.Name -eq 'mlh-vst3-scanner.exe' -or $isLegacyScanner) { 'scan' }
        elseif ($_.Name -eq 'mlh-audio-engine.exe') { 'live' }
        else { 'application' }
    [ordered]@{
        name = $_.Name
        pid = [int]$_.ProcessId
        parentPid = [int]$_.ParentProcessId
        createdAt = ([datetime]$_.CreationDate).ToUniversalTime().ToString('o')
        arguments = $_.CommandLine
        executablePath = $_.ExecutablePath
        role = $role
        opensHostAudioDevice = $role -eq 'live'
        lifetime = if ($role -eq 'scan') { 'bounded' } else { 'application' }
        reason = if ($role -eq 'live') { 'Electron main-process singleton' }
            elseif ($role -eq 'scan') { 'VST3 metadata isolation' }
            else { 'Electron runtime' }
    }
})

$sessions = @([MiniHub.AudioSessions]::EnumerateRenderSessions() | Where-Object {
    $_.ProcessName -in @('mlh-audio-engine', 'mlh-vst3-scanner', 'MiniHub')
} | ForEach-Object {
    [ordered]@{
        endpointId = $_.EndpointId
        pid = $_.ProcessId
        processName = $_.ProcessName
        processPath = $_.ProcessPath
        state = $_.State
        displayName = $_.DisplayName
        sessionIdentifier = $_.SessionIdentifier
        sessionInstanceIdentifier = $_.SessionInstanceIdentifier
    }
})

$liveEngines = @($nativeProcesses | Where-Object { $_.role -eq 'live' })
$scannerProcesses = @($nativeProcesses | Where-Object { $_.role -eq 'scan' })
$liveEnginePids = @($liveEngines | ForEach-Object { $_.pid })
$scannerPids = @($scannerProcesses | ForEach-Object { $_.pid })
$liveSessions = @($sessions | Where-Object { $liveEnginePids -contains $_.pid })
$scannerSessions = @($sessions | Where-Object { $scannerPids -contains $_.pid })
$snapshot = [ordered]@{
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    nativeProcesses = $nativeProcesses
    audioSessions = $sessions
    counts = [ordered]@{
        liveEngines = $liveEngines.Count
        liveEngineAudioSessions = $liveSessions.Count
        scannerProcesses = $scannerProcesses.Count
        scannerAudioSessions = $scannerSessions.Count
    }
}

$json = $snapshot | ConvertTo-Json -Depth 8
if ($OutputPath) {
    $resolved = [IO.Path]::GetFullPath($OutputPath)
    $parent = [IO.Path]::GetDirectoryName($resolved)
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($resolved, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}
$json

if ($RequireSingleLiveEngine -and $liveEngines.Count -ne 1) { exit 2 }
if ($RequireSingleAudioSession -and ($liveSessions.Count -ne 1 -or $scannerSessions.Count -ne 0)) { exit 3 }
