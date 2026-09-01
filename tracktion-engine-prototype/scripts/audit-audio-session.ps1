param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'

if (-not ('MiniHubTracktion.AudioSessions' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace MiniHubTracktion {
    public enum EDataFlow { Render, Capture, All }
    public enum AudioSessionState { Inactive, Active, Expired }
    [Flags] public enum DeviceState : uint { Active = 1 }
    [Flags] public enum ClsCtx : uint { All = 0x17 }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject {}

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    internal interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(EDataFlow flow, DeviceState mask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow flow, int role, out IMMDevice endpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr callback);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr callback);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    internal interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, ClsCtx context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(uint access, out IntPtr properties);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out DeviceState state);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    internal interface IAudioSessionManager2 {
        [PreserveSig] int GetAudioSessionControl(ref Guid sessionGuid, uint flags, out IntPtr control);
        [PreserveSig] int GetSimpleAudioVolume(ref Guid sessionGuid, uint flags, out IntPtr volume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
        [PreserveSig] int RegisterSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr notification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string id, IntPtr notification);
        [PreserveSig] int UnregisterDuckNotification(IntPtr notification);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    internal interface IAudioSessionEnumerator {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetSession(int index, out IAudioSessionControl control);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    internal interface IAudioSessionControl {
        [PreserveSig] int GetState(out AudioSessionState state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    internal interface IAudioSessionControl2 {
        [PreserveSig] int GetState(out AudioSessionState state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
        [PreserveSig] int GetGroupingParam(out Guid grouping);
        [PreserveSig] int SetGroupingParam(ref Guid grouping, ref Guid context);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notification);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetProcessId(out uint processId);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }

    public sealed class SessionRecord {
        public string EndpointId;
        public int ProcessId;
        public string State;
        public string Identifier;
        public string InstanceIdentifier;
    }

    public static class AudioSessions {
        private static void Release(object value) {
            if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value);
        }

        public static SessionRecord[] Enumerate() {
            var result = new List<SessionRecord>();
            IMMDeviceEnumerator devices = null;
            IMMDevice endpoint = null;
            IAudioSessionManager2 manager = null;
            IAudioSessionEnumerator sessions = null;
            try {
                devices = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                Marshal.ThrowExceptionForHR(devices.GetDefaultAudioEndpoint(EDataFlow.Render, 1, out endpoint));
                string endpointId;
                Marshal.ThrowExceptionForHR(endpoint.GetId(out endpointId));
                var iid = typeof(IAudioSessionManager2).GUID;
                object activated;
                Marshal.ThrowExceptionForHR(endpoint.Activate(ref iid, ClsCtx.All, IntPtr.Zero, out activated));
                manager = (IAudioSessionManager2)activated;
                Marshal.ThrowExceptionForHR(manager.GetSessionEnumerator(out sessions));
                int count;
                Marshal.ThrowExceptionForHR(sessions.GetCount(out count));
                for (var i = 0; i < count; ++i) {
                    IAudioSessionControl control = null;
                    try {
                        Marshal.ThrowExceptionForHR(sessions.GetSession(i, out control));
                        var control2 = (IAudioSessionControl2)control;
                        uint pid;
                        AudioSessionState state;
                        string id, instanceId;
                        Marshal.ThrowExceptionForHR(control2.GetProcessId(out pid));
                        Marshal.ThrowExceptionForHR(control2.GetState(out state));
                        control2.GetSessionIdentifier(out id);
                        control2.GetSessionInstanceIdentifier(out instanceId);
                        result.Add(new SessionRecord {
                            EndpointId = endpointId,
                            ProcessId = (int)pid,
                            State = state.ToString(),
                            Identifier = id ?? "",
                            InstanceIdentifier = instanceId ?? ""
                        });
                    } finally { Release(control); }
                }
            } finally { Release(sessions); Release(manager); Release(endpoint); Release(devices); }
            return result.ToArray();
        }
    }
}
'@
}

$matching = @([MiniHubTracktion.AudioSessions]::Enumerate() | Where-Object ProcessId -eq $ProcessId)
$snapshot = [ordered]@{
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    processId = $ProcessId
    sessionCount = $matching.Count
    activeSessionCount = @($matching | Where-Object State -eq 'Active').Count
    sessions = @($matching | ForEach-Object {
        [ordered]@{
            endpointId = $_.EndpointId
            state = $_.State
            identifier = $_.Identifier
            instanceIdentifier = $_.InstanceIdentifier
        }
    })
    pass = ($matching.Count -eq 1 -and @($matching | Where-Object State -eq 'Active').Count -eq 1)
}

$json = $snapshot | ConvertTo-Json -Depth 6
if ($OutputPath) {
    $resolved = [IO.Path]::GetFullPath($OutputPath)
    $parent = [IO.Path]::GetDirectoryName($resolved)
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [IO.File]::WriteAllText($resolved, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
}

$json
if (-not $snapshot.pass) { exit 1 }

