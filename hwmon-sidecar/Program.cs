using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using LibreHardwareMonitor.Hardware;

namespace NexusHwMon;

public sealed class UpdateVisitor : IVisitor
{
    public void VisitComputer(IComputer computer) => computer.Traverse(this);

    public void VisitHardware(IHardware hardware)
    {
        try
        {
            hardware.Update();
            foreach (var subHardware in hardware.SubHardware)
            {
                subHardware.Accept(this);
            }
        }
        catch
        {
            // Игнорируем сбои отдельных защищенных датчиков
        }
    }

    public void VisitSensor(ISensor sensor) { }
    public void VisitParameter(IParameter parameter) { }
}

public sealed class CoreTempDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("temp_c")]
    public float TempC { get; set; }
}

public sealed class CpuTelemetryDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "Процессор";

    [JsonPropertyName("package_temp_c")]
    public float? PackageTempC { get; set; }

    [JsonPropertyName("max_core_temp_c")]
    public float? MaxCoreTempC { get; set; }

    [JsonPropertyName("avg_clock_mhz")]
    public float? AvgClockMhz { get; set; }

    [JsonPropertyName("power_watts")]
    public float? PowerWatts { get; set; }

    [JsonPropertyName("voltage_v")]
    public float? VoltageV { get; set; }

    [JsonPropertyName("core_temps")]
    public List<CoreTempDto> CoreTemps { get; set; } = new();
}

public sealed class GpuTelemetryDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "Видеокарта";

    [JsonPropertyName("core_temp_c")]
    public float? CoreTempC { get; set; }

    [JsonPropertyName("hotspot_temp_c")]
    public float? HotspotTempC { get; set; }

    [JsonPropertyName("memory_temp_c")]
    public float? MemoryTempC { get; set; }

    [JsonPropertyName("core_clock_mhz")]
    public float? CoreClockMhz { get; set; }

    [JsonPropertyName("memory_clock_mhz")]
    public float? MemoryClockMhz { get; set; }

    [JsonPropertyName("fan_rpm")]
    public float? FanRpm { get; set; }

    [JsonPropertyName("fan_percent")]
    public float? FanPercent { get; set; }

    [JsonPropertyName("power_watts")]
    public float? PowerWatts { get; set; }

    [JsonPropertyName("voltage_v")]
    public float? VoltageV { get; set; }

    [JsonPropertyName("load_percent")]
    public float? LoadPercent { get; set; }

    [JsonPropertyName("vendor")]
    public string Vendor { get; set; } = "";

    [JsonPropertyName("vram_used_mb")]
    public float? VramUsedMb { get; set; }

    [JsonPropertyName("vram_total_mb")]
    public float? VramTotalMb { get; set; }

    [JsonPropertyName("vram_used_percent")]
    public float? VramUsedPercent { get; set; }

    [JsonPropertyName("d3d_shared_mb")]
    public float? D3dSharedMb { get; set; }

    [JsonPropertyName("memory_controller_load_percent")]
    public float? MemoryControllerLoadPercent { get; set; }

    [JsonPropertyName("video_engine_load_percent")]
    public float? VideoEngineLoadPercent { get; set; }

    [JsonPropertyName("power_limit_percent")]
    public float? PowerLimitPercent { get; set; }

    [JsonPropertyName("pcie_rx_mb_s")]
    public float? PcieRxMbS { get; set; }

    [JsonPropertyName("pcie_tx_mb_s")]
    public float? PcieTxMbS { get; set; }

    [JsonPropertyName("fans")]
    public List<FanSensorDto> Fans { get; set; } = new();

    [JsonPropertyName("telemetry_source")]
    public string TelemetrySource { get; set; } = "LibreHardwareMonitor";
}

public sealed class FanSensorDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("rpm")]
    public float Rpm { get; set; }

    [JsonPropertyName("percent")]
    public float? Percent { get; set; }
}

public sealed class TempSensorDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("temp_c")]
    public float TempC { get; set; }
}

public sealed class StorageTempDto
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("temp_c")]
    public float? TempC { get; set; }

    [JsonPropertyName("used_percent")]
    public float? UsedPercent { get; set; }
}

public sealed class HardwareTelemetryDto
{
    [JsonPropertyName("is_admin")]
    public bool IsAdmin { get; set; }

    [JsonPropertyName("sidecar_online")]
    public bool SidecarOnline { get; set; } = true;

    [JsonPropertyName("timestamp_ms")]
    public long TimestampMs { get; set; }

    [JsonPropertyName("cpu")]
    public CpuTelemetryDto Cpu { get; set; } = new();

    [JsonPropertyName("gpus")]
    public List<GpuTelemetryDto> Gpus { get; set; } = new();

    [JsonPropertyName("motherboard_name")]
    public string MotherboardName { get; set; } = "Системная плата";

    [JsonPropertyName("motherboard_temps")]
    public List<TempSensorDto> MotherboardTemps { get; set; } = new();

    [JsonPropertyName("system_fans")]
    public List<FanSensorDto> SystemFans { get; set; } = new();

    [JsonPropertyName("storage_temps")]
    public List<StorageTempDto> StorageTemps { get; set; } = new();
}

internal static class Program
{
    private static volatile bool _shouldExit;

    private static bool CheckIsAdmin()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            using var identity = WindowsIdentity.GetCurrent();
            var principal = new WindowsPrincipal(identity);
            return principal.IsInRole(WindowsBuiltInRole.Administrator);
        }
        catch
        {
            return false;
        }
    }

    private static IEnumerable<ISensor> GetAllSensorsRecursive(IHardware hw)
    {
        foreach (var s in hw.Sensors)
        {
            yield return s;
        }
        foreach (var sub in hw.SubHardware)
        {
            foreach (var s in GetAllSensorsRecursive(sub))
            {
                yield return s;
            }
        }
    }

    private static bool IsValidTemp(float? val) =>
        val.HasValue && float.IsFinite(val.Value) && val.Value > 0f && val.Value < 130f;

    private static bool IsValidPositive(float? val) =>
        val.HasValue && float.IsFinite(val.Value) && val.Value >= 0f;

    private static GpuTelemetryDto MapGpuHardware(IHardware hw)
    {
        string vendor = hw.HardwareType switch
        {
            HardwareType.GpuNvidia => "NVIDIA",
            HardwareType.GpuAmd => "AMD",
            HardwareType.GpuIntel => "Intel",
            _ => ""
        };

        var gpu = new GpuTelemetryDto
        {
            Name = hw.Name,
            Vendor = vendor,
            TelemetrySource = vendor.Length > 0
                ? $"LibreHardwareMonitor ({vendor})"
                : "LibreHardwareMonitor"
        };

        float? coreLoad = null;
        float? d3d3dLoad = null;
        float? fallbackCoreLoad = null;
        float? vramLoadPct = null;
        float? videoDecodeLoad = null;
        float? videoEncodeLoad = null;
        float? videoEngineLoad = null;
        float? dedicatedUsedMb = null;
        float? d3dDedicatedUsedMb = null;
        float? powerPreferred = null;
        float? powerFallback = null;
        float? coreClockPreferred = null;

        var fanRpms = new Dictionary<string, (string DisplayName, float Rpm)>(StringComparer.OrdinalIgnoreCase);
        var fanControls = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);

        foreach (var s in GetAllSensorsRecursive(hw))
        {
            string sName = s.Name ?? "";
            string sLower = sName.Trim().ToLowerInvariant();

            if (s.SensorType == SensorType.Temperature && IsValidTemp(s.Value))
            {
                float t = s.Value!.Value;
                // Check memory BEFORE junction/hotspot so "GPU Memory Junction" maps strictly to VRAM memory temp.
                if (sLower.Contains("memory") || sLower.Contains("vram") || sLower.Contains("mem"))
                {
                    gpu.MemoryTempC = t;
                }
                else if (sLower.Contains("hot spot") || sLower.Contains("hotspot") || sLower.Contains("junction"))
                {
                    gpu.HotspotTempC = t;
                }
                else if (sLower.Contains("core") || sLower.Contains("edge") || !gpu.CoreTempC.HasValue)
                {
                    gpu.CoreTempC = t;
                }
            }
            else if (s.SensorType == SensorType.Clock && IsValidPositive(s.Value))
            {
                float mhz = s.Value!.Value;
                if (sLower.Contains("memory") || sLower.Contains("vram"))
                {
                    gpu.MemoryClockMhz = mhz;
                }
                else if (sLower == "gpu core" || sLower.Contains("graphics") || sLower.Contains("shader"))
                {
                    coreClockPreferred = mhz;
                }
                else if (sLower.Contains("core") && !coreClockPreferred.HasValue)
                {
                    coreClockPreferred = mhz;
                }
            }
            else if (s.SensorType == SensorType.Fan && IsValidPositive(s.Value))
            {
                float rpm = s.Value!.Value;
                fanRpms[sLower] = (sName.Trim(), rpm);
                if (!gpu.FanRpm.HasValue || rpm > gpu.FanRpm.Value)
                {
                    gpu.FanRpm = rpm;
                }
            }
            else if (s.SensorType == SensorType.Control && IsValidPositive(s.Value))
            {
                float pct = s.Value!.Value;
                fanControls[sLower] = pct;
                if (sLower.Contains("fan") && (!gpu.FanPercent.HasValue || pct > gpu.FanPercent.Value))
                {
                    gpu.FanPercent = pct;
                }
            }
            else if (s.SensorType == SensorType.Power && IsValidPositive(s.Value))
            {
                float watts = s.Value!.Value;
                if (sLower.Contains("package") || sLower.Contains("total board") || sLower == "gpu power" || sLower.Contains("ppt"))
                {
                    powerPreferred = watts;
                }
                else if (!powerFallback.HasValue)
                {
                    powerFallback = watts;
                }
            }
            else if (s.SensorType == SensorType.Load && IsValidPositive(s.Value))
            {
                float val = s.Value!.Value;
                if (sLower == "gpu core")
                {
                    coreLoad = val;
                }
                else if (sLower == "d3d 3d" || sLower == "3d")
                {
                    d3d3dLoad = val;
                }
                else if (sLower.Contains("memory controller"))
                {
                    gpu.MemoryControllerLoadPercent = val;
                }
                else if (sLower.Contains("video engine"))
                {
                    videoEngineLoad = val;
                }
                else if (sLower.Contains("d3d video decode"))
                {
                    videoDecodeLoad = val;
                }
                else if (sLower.Contains("d3d video encode"))
                {
                    videoEncodeLoad = val;
                }
                else if (sLower == "gpu board power" || sLower == "gpu power")
                {
                    gpu.PowerLimitPercent = val;
                }
                else if (sLower == "gpu memory" || sLower == "d3d dedicated memory usage")
                {
                    vramLoadPct = val;
                }
                else if ((sLower.Contains("core") || sLower == "gpu") && !fallbackCoreLoad.HasValue)
                {
                    fallbackCoreLoad = val;
                }
            }
            else if ((s.SensorType == SensorType.SmallData || s.SensorType == SensorType.Data) && IsValidPositive(s.Value))
            {
                float mb = s.SensorType == SensorType.Data ? s.Value!.Value * 1024f : s.Value!.Value;
                if (sLower == "gpu memory total")
                {
                    gpu.VramTotalMb = mb;
                }
                else if (sLower == "gpu memory used")
                {
                    dedicatedUsedMb = mb;
                }
                else if (sLower == "d3d dedicated memory used")
                {
                    d3dDedicatedUsedMb = mb;
                }
                else if (sLower == "d3d shared memory used")
                {
                    gpu.D3dSharedMb = mb;
                }
            }
            else if (s.SensorType == SensorType.Voltage && IsValidPositive(s.Value))
            {
                if (s.Value!.Value > 0.05f && (!gpu.VoltageV.HasValue || sLower.Contains("core")))
                {
                    gpu.VoltageV = s.Value.Value;
                }
            }
            else if (s.SensorType == SensorType.Throughput && IsValidPositive(s.Value))
            {
                float mbps = s.Value!.Value / (1024f * 1024f);
                if (sLower.Contains("pcie rx"))
                {
                    gpu.PcieRxMbS = mbps;
                }
                else if (sLower.Contains("pcie tx"))
                {
                    gpu.PcieTxMbS = mbps;
                }
            }
        }

        gpu.CoreClockMhz = coreClockPreferred;
        gpu.PowerWatts = powerPreferred ?? powerFallback;
        gpu.LoadPercent = coreLoad ?? d3d3dLoad ?? fallbackCoreLoad;
        gpu.VideoEngineLoadPercent = videoEngineLoad ?? (
            videoDecodeLoad.HasValue || videoEncodeLoad.HasValue
                ? MathF.Max(videoDecodeLoad ?? 0f, videoEncodeLoad ?? 0f)
                : null
        );
        gpu.VramUsedMb = dedicatedUsedMb ?? d3dDedicatedUsedMb;
        gpu.VramUsedPercent = vramLoadPct ?? (
            gpu.VramTotalMb is > 0f && gpu.VramUsedMb is >= 0f
                ? Math.Clamp((gpu.VramUsedMb.Value / gpu.VramTotalMb.Value) * 100f, 0f, 100f)
                : null
        );

        foreach (var kv in fanRpms)
        {
            float? ctrlPct = fanControls.TryGetValue(kv.Key, out float matchedPct)
                ? matchedPct
                : gpu.FanPercent;
            gpu.Fans.Add(new FanSensorDto
            {
                Name = kv.Value.DisplayName,
                Rpm = kv.Value.Rpm,
                Percent = ctrlPct
            });
        }

        return gpu;
    }

    public static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        bool isAdmin = CheckIsAdmin();

        // Отслеживание закрытия родительского процесса через закрытие потока stdin или Ctrl+C
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            _shouldExit = true;
        };

        _ = Task.Run(async () =>
        {
            try
            {
                while (await Console.In.ReadLineAsync() is not null)
                {
                    // Если родительский процесс жив и держит пайп открытым — ждём
                }
            }
            catch
            {
                // Поток ввода закрыт
            }
            _shouldExit = true;
        });

        var computer = new Computer
        {
            IsCpuEnabled = true,
            IsGpuEnabled = true,
            IsMotherboardEnabled = true,
            IsMemoryEnabled = true,
            IsStorageEnabled = true,
            IsControllerEnabled = true
        };

        try
        {
            computer.Open();
        }
        catch
        {
            // Продолжаем работу с доступными датчиками даже при частичной ошибке драйвера
        }

        var visitor = new UpdateVisitor();
        var jsonOptions = new JsonSerializerOptions
        {
            WriteIndented = false
        };

        while (!_shouldExit)
        {
            try
            {
                computer.Accept(visitor);
                var snapshot = BuildSnapshot(computer, isAdmin);
                string json = JsonSerializer.Serialize(snapshot, jsonOptions);
                Console.WriteLine(json);
                Console.Out.Flush();
            }
            catch
            {
                // Не прерываем цикл при единичной ошибке чтения
            }

            Thread.Sleep(1000);
        }

        try
        {
            computer.Close();
        }
        catch
        {
            // Игнорируем ошибки закрытия при выходе
        }
    }

    private static HardwareTelemetryDto BuildSnapshot(Computer computer, bool isAdmin)
    {
        var dto = new HardwareTelemetryDto
        {
            IsAdmin = isAdmin,
            SidecarOnline = true,
            TimestampMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
        };

        foreach (var hw in computer.Hardware)
        {
            switch (hw.HardwareType)
            {
                case HardwareType.Cpu:
                {
                    dto.Cpu.Name = hw.Name;
                    var clockValues = new List<float>();

                    foreach (var s in GetAllSensorsRecursive(hw))
                    {
                        string sName = s.Name ?? "";
                        string sLower = sName.ToLowerInvariant();

                        if (s.SensorType == SensorType.Temperature && IsValidTemp(s.Value))
                        {
                            if (sLower.Contains("distance")) continue;

                            float t = s.Value!.Value;
                            if (sLower.Contains("package") || sLower.Contains("tctl") || sLower.Contains("tdie") || sLower.Contains("average"))
                            {
                                dto.Cpu.PackageTempC = t;
                            }
                            else if (sLower.Contains("core") || sLower.Contains("ccd"))
                            {
                                dto.Cpu.CoreTemps.Add(new CoreTempDto
                                {
                                    Name = sName,
                                    TempC = t
                                });
                                if (!dto.Cpu.MaxCoreTempC.HasValue || t > dto.Cpu.MaxCoreTempC.Value)
                                {
                                    dto.Cpu.MaxCoreTempC = t;
                                }
                            }
                            else if (!dto.Cpu.PackageTempC.HasValue)
                            {
                                dto.Cpu.PackageTempC = t;
                            }
                        }
                        else if (s.SensorType == SensorType.Clock && IsValidPositive(s.Value))
                        {
                            if (!sLower.Contains("bus") && s.Value!.Value > 100f)
                            {
                                clockValues.Add(s.Value.Value);
                            }
                        }
                        else if (s.SensorType == SensorType.Power && IsValidPositive(s.Value))
                        {
                            if (sLower.Contains("package") || sLower.Contains("total") || !dto.Cpu.PowerWatts.HasValue)
                            {
                                dto.Cpu.PowerWatts = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Voltage && IsValidPositive(s.Value))
                        {
                            if ((sLower.Contains("core") || sLower.Contains("vid") || !dto.Cpu.VoltageV.HasValue) && s.Value!.Value > 0.2f && s.Value.Value < 2.5f)
                            {
                                dto.Cpu.VoltageV = s.Value.Value;
                            }
                        }
                    }

                    if (!dto.Cpu.PackageTempC.HasValue && dto.Cpu.MaxCoreTempC.HasValue)
                    {
                        dto.Cpu.PackageTempC = dto.Cpu.MaxCoreTempC;
                    }
                    if (!dto.Cpu.MaxCoreTempC.HasValue && dto.Cpu.PackageTempC.HasValue)
                    {
                        dto.Cpu.MaxCoreTempC = dto.Cpu.PackageTempC;
                    }
                    if (clockValues.Count > 0)
                    {
                        dto.Cpu.AvgClockMhz = clockValues.Average();
                    }
                    break;
                }

                case HardwareType.GpuNvidia:
                case HardwareType.GpuAmd:
                case HardwareType.GpuIntel:
                {
                    dto.Gpus.Add(MapGpuHardware(hw));
                    break;
                }

                case HardwareType.Motherboard:
                case HardwareType.SuperIO:
                case HardwareType.Cooler:
                case HardwareType.EmbeddedController:
                {
                    if (hw.HardwareType == HardwareType.Motherboard && !string.IsNullOrWhiteSpace(hw.Name))
                    {
                        dto.MotherboardName = hw.Name;
                    }

                    foreach (var s in GetAllSensorsRecursive(hw))
                    {
                        string sName = s.Name ?? "Датчик";
                        if (s.SensorType == SensorType.Fan && IsValidPositive(s.Value))
                        {
                            dto.SystemFans.Add(new FanSensorDto
                            {
                                Name = sName,
                                Rpm = s.Value!.Value
                            });
                        }
                        else if (s.SensorType == SensorType.Temperature && IsValidTemp(s.Value))
                        {
                            dto.MotherboardTemps.Add(new TempSensorDto
                            {
                                Name = sName,
                                TempC = s.Value!.Value
                            });
                        }
                    }
                    break;
                }

                case HardwareType.Storage:
                {
                    var st = new StorageTempDto
                    {
                        Name = hw.Name
                    };

                    foreach (var s in GetAllSensorsRecursive(hw))
                    {
                        string sLower = (s.Name ?? "").ToLowerInvariant();
                        if (s.SensorType == SensorType.Temperature && IsValidTemp(s.Value))
                        {
                            if (!st.TempC.HasValue || sLower.Contains("composite") || sLower.Contains("temperature"))
                            {
                                st.TempC = s.Value!.Value;
                            }
                        }
                        else if (s.SensorType == SensorType.Load && IsValidPositive(s.Value))
                        {
                            if (sLower.Contains("used"))
                            {
                                st.UsedPercent = s.Value!.Value;
                            }
                        }
                    }

                    dto.StorageTemps.Add(st);
                    break;
                }
            }
        }

        return dto;
    }
}
