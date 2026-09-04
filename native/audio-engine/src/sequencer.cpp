#include "sequencer.h"
#include "midi_network.h"
#include "midi_output.h"
#include "var_util.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace mlh {

namespace {
float boundedGain(const juce::var& value, float fallback=1.0f)
{
    if (!value.isInt() && !value.isInt64() && !value.isDouble()) return fallback;
    const auto number=(double)value;
    return std::isfinite(number)?juce::jlimit(0.0f, 2.0f, (float)number):fallback;
}
double boundedPpq(const juce::var& value, double fallback=0.0)
{
    if (!value.isInt() && !value.isInt64() && !value.isDouble()) return fallback;
    const auto number=(double)value;
    return std::isfinite(number)?juce::jlimit(0.0, 1000000.0, number):fallback;
}
bool validId(const juce::String& id)
{
    return id.isNotEmpty() && id.length() <= 160
        && id.containsOnly("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-");
}

class CancelableLameWriter final : public juce::AudioFormatWriter {
public:
    CancelableLameWriter(juce::OutputStream* destination, const juce::File& lame,
                         int bitrateKbps, double sampleRate)
        : AudioFormatWriter(destination, "MP3 file", sampleRate, 2, 16),
          lame_(lame), bitrateKbps_(bitrateKbps)
    {
        std::unique_ptr<juce::OutputStream> stream = tempWav_.getFile().createOutputStream();
        juce::WavAudioFormat wav;
        wavWriter_ = wav.createWriterFor(stream,
            juce::AudioFormatWriter::Options{}
                .withSampleRate(sampleRate)
                .withNumChannels(2)
                .withBitsPerSample(16));
    }

    ~CancelableLameWriter() override
    {
        wavWriter_.reset();
        if (!cancelled_)
            convertToMp3();
    }

    bool write(const int** samples, int numSamples) override
    {
        return wavWriter_ != nullptr && wavWriter_->write(samples, numSamples);
    }

    bool openedOk() const noexcept { return wavWriter_ != nullptr; }
    void cancel() noexcept { cancelled_ = true; }

private:
    bool convertToMp3()
    {
        juce::TemporaryFile tempMp3(".mp3");
        juce::StringArray args;
        args.add(lame_.getFullPathName());
        args.add("--quiet");
        args.add("--cbr");
        args.add("-b");
        args.add(juce::String(bitrateKbps_));
        args.add(tempWav_.getFile().getFullPathName());
        args.add(tempMp3.getFile().getFullPathName());
        juce::ChildProcess child;
        if (!child.start(args))
            return false;
        child.readAllProcessOutput();
        child.waitForProcessToFinish(10000);
        if (tempMp3.getFile().getSize() <= 0)
            return false;
        juce::FileInputStream input(tempMp3.getFile());
        if (!input.openedOk() || output->writeFromInputStream(input, -1) <= 0)
            return false;
        output->flush();
        return true;
    }

    juce::File lame_;
    int bitrateKbps_ = 320;
    bool cancelled_ = false;
    juce::TemporaryFile tempWav_ { ".wav" };
    std::unique_ptr<juce::AudioFormatWriter> wavWriter_;
};

std::unique_ptr<juce::AudioFormatWriter> createExportWriter(
    const juce::File& file, double sampleRate,
    const SequencerEngine::ExportOptions& options, juce::String& error)
{
    const auto format = options.format.trim().toLowerCase();
    const auto expectedExtension = "." + format;
    if (format != "wav" && format != "mp3" && format != "ogg") {
        error = "Unsupported export format";
        return {};
    }
    if (!file.hasFileExtension(expectedExtension)) {
        error = "Export filename must end in " + expectedExtension;
        return {};
    }
    if (file.existsAsFile() && !file.deleteFile()) {
        error = "Could not replace the existing export file";
        return {};
    }
    std::unique_ptr<juce::OutputStream> stream = file.createOutputStream();
    if (!stream) {
        error = "Could not create export file";
        return {};
    }

    auto writerOptions = juce::AudioFormatWriter::Options{}
        .withSampleRate(sampleRate)
        .withNumChannels(2);
    std::unique_ptr<juce::AudioFormatWriter> writer;
    if (format == "wav") {
        if (options.wavBits != 16 && options.wavBits != 24 && options.wavBits != 32) {
            error = "WAV bit depth must be 16, 24 or 32";
            return {};
        }
        juce::WavAudioFormat wav;
        writer = wav.createWriterFor(stream,
            writerOptions.withBitsPerSample(options.wavBits));
    } else if (format == "ogg") {
        juce::OggVorbisAudioFormat ogg;
        const auto qualities = ogg.getQualityOptions();
        const int quality = options.oggQualityIndex < 0
            ? qualities.size() - 1
            : options.oggQualityIndex;
        if (!juce::isPositiveAndBelow(quality, qualities.size())) {
            error = "OGG quality option is invalid";
            return {};
        }
        writer = ogg.createWriterFor(stream,
            writerOptions.withBitsPerSample(32).withQualityOptionIndex(quality));
    } else {
        static constexpr int supportedBitrates[] = { 128, 192, 256, 320 };
        if (std::find(std::begin(supportedBitrates), std::end(supportedBitrates),
                      options.mp3BitrateKbps) == std::end(supportedBitrates)) {
            error = "MP3 bitrate must be 128, 192, 256 or 320 kbps";
            return {};
        }
        const auto lame = SequencerEngine::bundledLameExecutable();
        if (!lame.existsAsFile()) {
            error = "Bundled LAME MP3 encoder is missing";
            return {};
        }
        auto mp3 = std::make_unique<CancelableLameWriter>(
            stream.release(), lame, options.mp3BitrateKbps, sampleRate);
        if (mp3->openedOk()) writer = std::move(mp3);
    }
    if (!writer) {
        error = "Could not create " + format.toUpperCase() + " writer";
        file.deleteFile();
    }
    return writer;
}
}

SequencerEngine::SequencerEngine()
{
    formats_.registerBasicFormats();
}

SequencerEngine::~SequencerEngine()
{
    exportActive_.store(false);
    exportTransactionActive_.store(false);
    while (exportCallbacks_.load(std::memory_order_acquire) > 0) juce::Thread::yield();
    exportPlan_.store(nullptr, std::memory_order_release);
    preparedExportPlan_.reset();
    exportWriter_.reset();
    for (auto& item : takeWriters_) item.second->stop();
}

juce::File SequencerEngine::bundledLameExecutable()
{
    return juce::File::getSpecialLocation(juce::File::currentExecutableFile)
        .getSiblingFile("lame.exe");
}

juce::StringArray SequencerEngine::oggQualityOptions()
{
    return juce::OggVorbisAudioFormat{}.getQualityOptions();
}

juce::var SequencerEngine::exportSnapshotTrace() const
{
    juce::var snapshot=makeObject();auto* plan=exportPlan_.load(std::memory_order_acquire);if(!plan)return snapshot;setProp(snapshot,"generation",static_cast<juce::int64>(plan->generation));juce::Array<juce::var> tracks;for(const auto& track:plan->tracks){juce::var trackTrace=makeObject();setProp(trackTrace,"id",juce::String(track.id));setProp(trackTrace,"type",juce::String(track.type));setProp(trackTrace,"muted",track.runtime&&track.runtime->muted.load(std::memory_order_acquire));setProp(trackTrace,"volume",track.runtime?track.runtime->gain.load(std::memory_order_acquire):1.0f);setProp(trackTrace,"armed",track.armed);setProp(trackTrace,"inputId",juce::String(track.inputId));setProp(trackTrace,"outputId",juce::String(track.outputId));juce::Array<juce::var> clips;for(const auto& clip:track.clips){juce::var clipTrace=makeObject();setProp(clipTrace,"id",juce::String(clip.id));setProp(clipTrace,"type",juce::String(clip.type));setProp(clipTrace,"startPpq",clip.startPpq);setProp(clipTrace,"lengthPpq",clip.lengthPpq);setProp(clipTrace,"state",clip.available?"scheduled":"unavailable");clips.add(clipTrace);}setProp(trackTrace,"clips",clips);tracks.add(trackTrace);}setProp(snapshot,"tracks",tracks);return snapshot;
}

void SequencerEngine::prepare(double sampleRate, int blockSize)
{
    sampleRate_ = sampleRate > 0 ? sampleRate : 48000;
    blockSize_ = std::max(1, blockSize);
    for (auto& item : takeWriters_) item.second->prepare(sampleRate_, blockSize_);
}

bool SequencerEngine::sync(const juce::var& project,
                           const std::function<Chain*(const std::string&)>& chainLookup,
                           double engineSampleRate, int maxBlockSize,
                           juce::Array<juce::var>& audioInfo, std::string& error)
{
    const auto* tracks = project["tracks"].getArray();
    const auto failClosed=[&](const char* message){error=message;clearPlan();return false;};
    if (!tracks) return failClosed("Sequencer tracks must be an array");
    if (tracks->size() > 64) return failClosed("Sequencer supports at most 64 tracks");
    auto next=std::make_unique<Plan>();next->generation=++nextPlanGeneration_;
    for (const auto& value : *tracks) {
        Track track;
        const auto id=value["id"].toString();
        if (!validId(id)) return failClosed("Invalid Sequencer track id");
        track.id=id.toStdString();track.type=value["type"].toString().toStdString();
        if (track.type!="midi" && track.type!="audio") return failClosed("Unknown Sequencer track type");
        track.inputId=value["inputId"].toString().toStdString();track.outputId=value["outputId"].toString().toStdString();
        track.armed=value["armed"].isBool()?(bool)value["armed"]:false;
        track.runtime=std::make_shared<TrackRuntime>();
        track.runtime->muted.store(value["muted"].isBool()?(bool)value["muted"]:false,
                                   std::memory_order_relaxed);
        track.runtime->gain.store(boundedGain(value["volume"]),std::memory_order_relaxed);
        if (track.type=="midi" && !track.outputId.empty()) {
            const auto outputKind=value["outputKind"].toString();
            // The kind decides, never the id. The renderer sends the node's type
            // for every track output, so comparing the id to one keyboard's name
            // was both redundant and the last hardware literal in the engine.
            if(outputKind=="midi-output")track.midiOutputKind=Track::MidiOutputKind::physical;
            else if(outputKind=="arpeggiator")track.midiOutputKind=Track::MidiOutputKind::processor;
            else{track.destination=chainLookup(track.outputId);if(!track.destination&&outputKind.isNotEmpty())track.midiOutputKind=Track::MidiOutputKind::processor;}
        }
        if (track.type=="audio") {
            auto& owned=takeWriters_[track.id];if(!owned)owned=std::make_unique<AudioTakeWriter>(track.id);
            owned->prepare(engineSampleRate,maxBlockSize);track.takeWriter=owned.get();
            // Runtime callbacks never exceed maxBlockSize. Keep a modest
            // offline/direct-test reserve as well so loop-boundary probes can
            // render a longer diagnostic span without callback allocation.
            track.audioSumScratch.setSize(2,std::max(maxBlockSize,4096),false,true,false);
            track.audioSumScratch.clear();
        }
        const auto* clips=value["clips"].getArray();
        if (clips && clips->size()>2048) return failClosed("Too many clips on a Sequencer track");
        if (clips) for (const auto& clipValue : *clips) {
            const double clipStart=boundedPpq(clipValue["startPpq"]),clipLength=std::max(0.03125,boundedPpq(clipValue["lengthPpq"],4));
            track.clips.push_back({clipValue["id"].toString().toStdString(),track.type,clipStart,clipLength,true});
            if (track.type=="midi") {
                const double sourceOffset=boundedPpq(clipValue["sourceOffsetPpq"]);
                const double sourceEnd=sourceOffset+clipLength;
                const auto* notes=clipValue["notes"].getArray();if(!notes)continue;
                if(notes->size()>65536)return failClosed("Too many MIDI notes in a clip");
                for(const auto& note:*notes){const double noteStart=boundedPpq(note["startPpq"]),noteEnd=noteStart+std::max(0.001,boundedPpq(note["durationPpq"],.25));if(noteEnd<=sourceOffset||noteStart>=sourceEnd)continue;MidiEvent event;event.startPpq=clipStart+std::max(noteStart,sourceOffset)-sourceOffset;event.endPpq=clipStart+std::min(noteEnd,sourceEnd)-sourceOffset;event.pitch=(uint8_t)juce::jlimit(0,127,(int)note["pitch"]);event.velocity=(uint8_t)juce::jlimit(1,127,(int)note["velocity"]);event.channel=(uint8_t)juce::jlimit(1,16,(int)note["channel"]);track.midi.push_back(event);}
            } else {
                const auto clipId=clipValue["id"].toString();const juce::File file(clipValue["filePath"].toString());
                if(!validId(clipId))return failClosed("Invalid Sequencer audio clip id");
                const auto silentClip=[&](const juce::String& message){
                    track.clips.back().available=false;
                    juce::var info=makeObject();setProp(info,"type","sequencerAudioInfo");setProp(info,"clipId",clipId);
                    setProp(info,"available",false);setProp(info,"message",message);
                    const double remembered=boundedPpq(clipValue["durationSeconds"]);if(remembered>0)setProp(info,"durationSeconds",remembered);
                    audioInfo.add(info);
                };
                if(!file.existsAsFile()){silentClip("Audio file is missing: "+file.getFullPathName());continue;}
                const auto assetKey=file.getFullPathName().toStdString()+":"+std::to_string(file.getSize())+":"+std::to_string(file.getLastModificationTime().toMilliseconds());auto assetFound=audioAssets_.find(assetKey);std::shared_ptr<AudioAsset> asset;
                if(assetFound!=audioAssets_.end())asset=assetFound->second;else{std::unique_ptr<juce::AudioFormatReader> reader(formats_.createReaderFor(file));if(!reader){silentClip("Unsupported audio file: "+file.getFullPathName());continue;}if(reader->lengthInSamples<=0||reader->lengthInSamples>std::numeric_limits<int>::max()){silentClip("Audio file is empty or too large: "+file.getFullPathName());continue;}asset=std::make_shared<AudioAsset>();asset->sampleRate=reader->sampleRate;asset->durationSeconds=double(reader->lengthInSamples)/reader->sampleRate;asset->samples.setSize(2,(int)reader->lengthInSamples,false,true,false);reader->read(&asset->samples,0,(int)reader->lengthInSamples,0,true,true);if(reader->numChannels==1)asset->samples.copyFrom(1,0,asset->samples,0,0,asset->samples.getNumSamples());const int buckets=std::min(256,std::max(1,(int)reader->lengthInSamples));for(int b=0;b<buckets;++b){const int begin=(int)(int64_t(b)*reader->lengthInSamples/buckets),end=(int)(int64_t(b+1)*reader->lengthInSamples/buckets);float peak=0;for(int ch=0;ch<2;++ch)peak=std::max(peak,asset->samples.getMagnitude(ch,begin,std::max(1,end-begin)));asset->peaks.push_back(peak);}audioAssets_[assetKey]=asset;}
                AudioClip clip;clip.id=clipId.toStdString();clip.startPpq=clipStart;clip.lengthPpq=clipLength;clip.gain=boundedGain(clipValue["gain"]);clip.asset=asset;
                const double duration=asset->durationSeconds;clip.trimStartSeconds=juce::jlimit(0.0,duration,boundedPpq(clipValue["trimStartSeconds"]));clip.trimEndSeconds=juce::jlimit(clip.trimStartSeconds,duration,boundedPpq(clipValue["trimEndSeconds"],duration));
                juce::var info=makeObject();setProp(info,"type","sequencerAudioInfo");setProp(info,"clipId",clipId);setProp(info,"available",true);setProp(info,"durationSeconds",duration);setProp(info,"bpm",120.0);
                juce::Array<juce::var> peaks;for(const auto peak:asset->peaks)peaks.add(peak);setProp(info,"peaks",peaks);audioInfo.add(info);
                track.audio.push_back(std::move(clip));
            }
        }
        std::sort(track.midi.begin(),track.midi.end(),[](const auto&a,const auto&b){return a.startPpq<b.startPpq||(a.startPpq==b.startPpq&&a.pitch<b.pitch);});
        if (track.type=="midi") track.midiScratch.ensureSize(std::max<size_t>(8192, track.midi.size()*24+256));
        next->tracks.push_back(std::move(track));
    }
    auto* published=next.get();plans_.push_back(std::move(next));activePlan_.store(published,std::memory_order_release);
    // Plans are immutable and retained until shutdown. Publishing while the
    // callback owns an older raw pointer can therefore never reclaim live
    // audio/MIDI data. Large decoded audio assets are shared across those
    // plans by a file identity cache, so edits do not duplicate sample data.
    const auto* hazard=planHazard_.load(std::memory_order_acquire);
    const auto* exportPlan=exportPlan_.load(std::memory_order_acquire);
    plans_.erase(std::remove_if(plans_.begin(),plans_.end(),[published,hazard,exportPlan](const auto& owned){return owned.get()!=published&&owned.get()!=hazard&&owned.get()!=exportPlan;}),plans_.end());
    panic();return true;
}

void SequencerEngine::clearPlan()
{
    // Gate old chain destinations before replacing their plan. Calling panic
    // after publication would only inspect the new empty plan and could strand
    // notes whose future Note Offs were just discarded.
    panic();
    auto next=std::make_unique<Plan>();next->generation=++nextPlanGeneration_;auto* published=next.get();plans_.push_back(std::move(next));
    activePlan_.store(published,std::memory_order_release);
    const auto* hazard=planHazard_.load(std::memory_order_acquire);
    const auto* exportPlan=exportPlan_.load(std::memory_order_acquire);
    plans_.erase(std::remove_if(plans_.begin(),plans_.end(),[published,hazard,exportPlan](const auto& owned){return owned.get()!=published&&owned.get()!=hazard&&owned.get()!=exportPlan;}),plans_.end());
}

SequencerEngine::Plan* SequencerEngine::acquirePlan(bool exportContext) noexcept
{
    Plan* plan=nullptr;
    Plan* current=nullptr;
    do {
        plan = exportContext ? exportPlan_.load(std::memory_order_acquire)
                             : activePlan_.load(std::memory_order_acquire);
        planHazard_.store(plan,std::memory_order_release);
        current = exportContext ? exportPlan_.load(std::memory_order_acquire)
                                : activePlan_.load(std::memory_order_acquire);
    } while (plan != current);
    return plan;
}
void SequencerEngine::releasePlan() noexcept { planHazard_.store(nullptr,std::memory_order_release); }

int SequencerEngine::eventOffset(double target,double start,double qps,int count,const Transport& transport) noexcept
{
    if(qps<=0||count<=0)return-1;
    if(!transport.loopEnabled()){const double delta=target-start;if(delta<-1.0e-9)return-1;const int offset=(int)std::llround(delta/qps);return offset>=0&&offset<count?offset:-1;}
    const double a=transport.loopStart(),b=transport.loopEnd(),length=b-a;
    if(target<a||target>=b||length<=0)return-1;
    double delta=target-start;if(delta<0)delta+=length;const int offset=(int)std::llround(delta/qps);return offset>=0&&offset<count?offset:-1;
}

void SequencerEngine::processMidi(int count,Transport& transport,MidiExecutionPlan* midiPlan,MidiOutputSink* hardware,double callbackStartMs) noexcept
{
    const bool exportContext=&transport==&offlineExportTransport_;auto* plan=acquirePlan(exportContext);if(!plan)return;
    const bool cleanup=(exportContext?exportMidiCleanupPending_:midiCleanupPending_).exchange(false,std::memory_order_acq_rel);
    const bool playing=transport.processingPlaying()&&transport.playing();
    if(!playing&&!cleanup){releasePlan();return;}
    const double start=transport.ppqPosition(),qps=transport.quarterNotesPerSample();const bool chase=playing&&(exportContext?needsExportChase_:needsChase_).exchange(false);
    const bool sourceEnded=exportContext&&start>=exportSourceEndPpq();
    const bool sourceStopsThisBlock = playing&&exportContext
        && !exportSourceStopSent_.load(std::memory_order_acquire)
        && start + qps * count >= exportSourceEndPpq() - 1.0e-9;
    const int sourceStopOffset = sourceStopsThisBlock
        ? juce::jlimit(0, count - 1,
            (int)std::llround((exportSourceEndPpq() - start) / qps))
        : -1;
    for(auto& track:plan->tracks){if(track.type!="midi"||track.outputId.empty())continue;auto& buffer=track.midiScratch;buffer.clear();
        const auto destinationEpoch=track.destination?track.destination->midiEpoch():0;
        if(cleanup){for(int channel=1;channel<=16;++channel){for(int pitch=0;pitch<128;++pitch){auto& held=track.activeNotes[(size_t)((channel-1)*128+pitch)];while(held>0){buffer.addEvent(juce::MidiMessage::noteOff(channel,pitch),0);--held;}}buffer.addEvent(juce::MidiMessage::allNotesOff(channel),0);buffer.addEvent(juce::MidiMessage::allSoundOff(channel),0);}}
        const bool muted=track.runtime&&track.runtime->muted.load(std::memory_order_acquire);
        int activeClips=0;
        if(playing&&!muted){for(const auto& clip:track.clips){bool active=false;for(int sample=0;sample<count&&!active;++sample){const double q=transport.ppqAtSample(sample);active=q>=clip.startPpq&&q<clip.startPpq+clip.lengthPpq;}if(active)++activeClips;}
            for(const auto& event:track.midi){int on=sourceEnded?-1:eventOffset(event.startPpq,start,qps,count,transport),off=eventOffset(event.endPpq,start,qps,count,transport);if(exportContext&&event.startPpq>=exportSourceEndPpq())on=-1;if(on>=0)buffer.addEvent(juce::MidiMessage::noteOn((int)event.channel,(int)event.pitch,(juce::uint8)event.velocity),on);else if(chase&&!sourceEnded&&!transport.loopEnabled()&&event.startPpq<start&&event.endPpq>start)buffer.addEvent(juce::MidiMessage::noteOn((int)event.channel,(int)event.pitch,(juce::uint8)event.velocity),0);if(off>=0)buffer.addEvent(juce::MidiMessage::noteOff((int)event.channel,(int)event.pitch),off);else if(transport.loopEnabled()&&event.startPpq<transport.loopEnd()&&event.endPpq>=transport.loopEnd()){const int boundary=(int)std::llround((transport.loopEnd()-start)/qps);if(boundary>=0&&boundary<=count)buffer.addEvent(juce::MidiMessage::noteOff((int)event.channel,(int)event.pitch),std::min(count-1,boundary));}}
        }
        if(track.runtime)track.runtime->activeClips.store(activeClips,std::memory_order_release);
        if(sourceStopsThisBlock)for(int channel=1;channel<=16;++channel){buffer.addEvent(juce::MidiMessage::allNotesOff(channel),sourceStopOffset);buffer.addEvent(juce::MidiMessage::allSoundOff(channel),sourceStopOffset);}
        if(buffer.isEmpty())continue;
        const bool mayDispatch=cleanup||transport.playing();if(!mayDispatch)continue;
        if(track.midiOutputKind==Track::MidiOutputKind::physical){if(hardware)hardware->sendBlock(buffer,callbackStartMs,sampleRate_);}else if(track.midiOutputKind==Track::MidiOutputKind::processor){if(midiPlan)midiPlan->pushInputBuffer(track.outputId,buffer);}else if(track.destination)track.destination->pushMidi(buffer,destinationEpoch);
        for(const auto& item:buffer){const auto message=item.getMessage();const int channel=message.getChannel();if(channel<1||channel>16)continue;auto index=[channel](int pitch){return(size_t)((channel-1)*128+pitch);};if(message.isNoteOn()){auto& held=track.activeNotes[index(message.getNoteNumber())];if(held<std::numeric_limits<uint16_t>::max())++held;}else if(message.isNoteOff()){auto& held=track.activeNotes[index(message.getNoteNumber())];if(held>0)--held;}else if(message.isAllNotesOff()||message.isAllSoundOff())for(int pitch=0;pitch<128;++pitch)track.activeNotes[index(pitch)]=0;}
    }
    if(sourceStopsThisBlock){exportSourceStopSent_.store(true,std::memory_order_release);if(midiPlan)midiPlan->panicAll(nullptr);}
    releasePlan();
}

void SequencerEngine::renderAudio(juce::AudioBuffer<float>& out,int count,Transport& transport) noexcept
{
    renderAudioForOutput(out,count,transport,{});
}

void SequencerEngine::renderAudioForOutput(juce::AudioBuffer<float>& out,int count,Transport& transport,const std::string& outputId) noexcept
{
    out.clear(0,count);if(!transport.processingPlaying())return;const bool exportContext=&transport==&offlineExportTransport_;auto* plan=acquirePlan(exportContext);if(!plan)return;
    const double bpm=transport.bpm();
    for(auto& track:plan->tracks){if(track.type!="audio"||(!outputId.empty()&&track.outputId!=outputId))continue;auto& sum=track.audioSumScratch;sum.clear(0,count);int activeClips=0;float peakBeforeSum=0;
        for(const auto& clip:track.audio){if(!clip.asset)continue;bool active=false;for(int sample=0;sample<count;++sample){const double q=transport.ppqAtSample(sample);if(exportContext&&q>=exportSourceEndPpq())continue;if(q<clip.startPpq||q>=clip.startPpq+clip.lengthPpq)continue;const double seconds=clip.trimStartSeconds+(q-clip.startPpq)*60.0/bpm;if(seconds<clip.trimStartSeconds||seconds>=clip.trimEndSeconds)continue;const double source=seconds*clip.asset->sampleRate;const int i=(int)source;if(i<0||i+1>=clip.asset->samples.getNumSamples())continue;active=true;const float f=(float)(source-i);for(int ch=0;ch<2;++ch){const float* data=clip.asset->samples.getReadPointer(ch);const float value=(data[i]+(data[i+1]-data[i])*f)*clip.gain;peakBeforeSum=std::max(peakBeforeSum,std::abs(value));sum.addSample(ch,sample,value);}}if(active)++activeClips;}
        const float peakAfterSum=std::max(sum.getMagnitude(0,0,count),sum.getMagnitude(1,0,count));const bool muted=track.runtime&&track.runtime->muted.load(std::memory_order_acquire);const float gain=muted?0.0f:(track.runtime?track.runtime->gain.load(std::memory_order_acquire):1.0f);if(gain!=1.0f)sum.applyGain(0,count,gain);const float peakAfterGain=std::max(sum.getMagnitude(0,0,count),sum.getMagnitude(1,0,count));
        if(track.runtime){track.runtime->activeClips.store(activeClips,std::memory_order_release);track.runtime->peakBeforeSum.store(peakBeforeSum,std::memory_order_release);track.runtime->peakAfterSum.store(peakAfterSum,std::memory_order_release);track.runtime->gainApplied.store(gain,std::memory_order_release);track.runtime->peakAfterGain.store(peakAfterGain,std::memory_order_release);}for(int ch=0;ch<2;++ch)out.addFrom(ch,0,sum,ch,0,count);
    }
    releasePlan();
}

bool SequencerEngine::setTrackControl(const std::string& trackId,float gain,bool muted) noexcept
{
    if(!std::isfinite(gain))return false;auto* plan=activePlan_.load(std::memory_order_acquire);if(!plan)return false;
    for(auto& track:plan->tracks)if(track.id==trackId&&track.runtime){track.runtime->gain.store(std::clamp(gain,0.0f,2.0f),std::memory_order_release);const bool wasMuted=track.runtime->muted.exchange(muted,std::memory_order_acq_rel);if(track.type=="midi"&&muted&&!wasMuted){midiCleanupPending_.store(true,std::memory_order_release);if(track.destination)track.destination->panic();}return true;}return false;
}

SequencerEngine::MidiTrackGain SequencerEngine::midiTrackGainForOutput(const std::string& outputId,const Transport& transport) noexcept
{
    const bool exportContext=&transport==&offlineExportTransport_;auto* plan=exportContext?exportPlan_.load(std::memory_order_acquire):activePlan_.load(std::memory_order_acquire);if(!plan)return{};
    for(auto& track:plan->tracks)if(track.type=="midi"&&track.midiOutputKind==Track::MidiOutputKind::chain&&track.outputId==outputId&&track.runtime){const bool muted=track.runtime->muted.load(std::memory_order_acquire);const float gain=muted?0.0f:track.runtime->gain.load(std::memory_order_acquire);track.runtime->gainApplied.store(gain,std::memory_order_release);return{true,gain};}return{};
}

void SequencerEngine::observeMidiTrackGain(const std::string& outputId,const Transport& transport,float peakBeforeGain,float gainApplied,float peakAfterGain) noexcept
{
    const bool exportContext=&transport==&offlineExportTransport_;auto* plan=exportContext?exportPlan_.load(std::memory_order_acquire):activePlan_.load(std::memory_order_acquire);if(!plan)return;
    for(auto& track:plan->tracks)if(track.type=="midi"&&track.midiOutputKind==Track::MidiOutputKind::chain&&track.outputId==outputId&&track.runtime){track.runtime->peakBeforeSum.store(peakBeforeGain,std::memory_order_release);track.runtime->peakAfterSum.store(peakBeforeGain,std::memory_order_release);track.runtime->gainApplied.store(gainApplied,std::memory_order_release);track.runtime->peakAfterGain.store(peakAfterGain,std::memory_order_release);}
}

std::vector<SequencerEngine::TrackSignalTrace> SequencerEngine::trackSignalTrace(const Transport* transport) const
{
    const bool exportContext=transport==&offlineExportTransport_;auto* plan=exportContext?exportPlan_.load(std::memory_order_acquire):activePlan_.load(std::memory_order_acquire);std::vector<TrackSignalTrace> result;if(!plan)return result;result.reserve(plan->tracks.size());
    for(const auto& track:plan->tracks){TrackSignalTrace trace;trace.trackId=track.id;trace.trackType=track.type;trace.destinationBuffer=track.outputId.empty()?"unrouted":track.outputId+":audio-in";if(track.runtime){trace.activeClips=track.runtime->activeClips.load(std::memory_order_acquire);trace.peakBeforeSum=track.runtime->peakBeforeSum.load(std::memory_order_acquire);trace.peakAfterSum=track.runtime->peakAfterSum.load(std::memory_order_acquire);trace.gainApplied=track.runtime->gainApplied.load(std::memory_order_acquire);trace.peakAfterGain=track.runtime->peakAfterGain.load(std::memory_order_acquire);}result.push_back(std::move(trace));}return result;
}

void SequencerEngine::captureSource(const std::string& source,const juce::AudioBuffer<float>& audio,int count,Transport& transport) noexcept
{
    if(!recording_.load(std::memory_order_relaxed))return;auto* plan=acquirePlan(false);if(!plan)return;for(auto& track:plan->tracks)if(track.type=="audio"&&track.armed&&track.inputId==source&&track.takeWriter)track.takeWriter->process(audio,count);releasePlan();
}

void SequencerEngine::beginRecording(Transport& transport)
{
    if(recording_.exchange(true))return;midiTakes_.clear();audioTakes_.clear();auto* plan=activePlan_.load();if(!plan){recording_=false;return;}
    for(auto& track:plan->tracks)if(track.armed){if(track.type=="midi"){MidiTake take;take.trackId=track.id;take.sourceId=track.inputId;take.startPpq=take.lastPpq=transport.ppqPosition();midiTakes_.push_back(std::move(take));}else if(track.takeWriter&&!track.inputId.empty()&&track.takeWriter->begin()){audioTakes_.push_back({track.id,track.takeWriter,transport.ppqPosition(),transport.bpm()});}}
    transport.setRecording(true);if(!transport.playing())transport.setPlaying(true);
}

double SequencerEngine::recordedPpq(MidiTake& take,Transport& transport) const noexcept
{
    const double current=transport.ppqPosition();if(transport.loopEnabled()&&current+1.0e-6<take.lastPpq)take.loopOffset+=transport.loopEnd()-transport.loopStart();take.lastPpq=current;return current+take.loopOffset;
}

void SequencerEngine::recordMidiInput(const std::string& source,const juce::MidiMessage& message,double offsetMs,Transport& transport)
{
    if(!recording())return;for(auto& take:midiTakes_){if(take.sourceId.empty()||take.sourceId!=source)continue;double q=recordedPpq(take,transport)+offsetMs*transport.bpm()/60000.0;q=std::max(take.startPpq,q);const int channel=message.getChannel(),pitch=message.getNoteNumber(),key=channel*128+pitch;if(message.isNoteOn()){take.active[key].push_back({q,message.getVelocity()});}else if(message.isNoteOff()){auto found=take.active.find(key);if(found==take.active.end()||found->second.empty())continue;const auto active=found->second.back();found->second.pop_back();take.events.push_back({active.startPpq,std::max(.001,q-active.startPpq),pitch,active.velocity,channel});}}
}

void SequencerEngine::closeMidiNotes(MidiTake& take,double end)
{
    for(auto& keyed:take.active){const int channel=keyed.first/128,pitch=keyed.first%128;for(const auto& active:keyed.second)take.events.push_back({active.startPpq,std::max(.001,end-active.startPpq),pitch,active.velocity,channel});}take.active.clear();
}

juce::Array<juce::var> SequencerEngine::finishRecording(Transport& transport)
{
    juce::Array<juce::var> result;if(!recording_.exchange(false))return result;transport.setRecording(false);
    for(auto& take:midiTakes_){const double end=recordedPpq(take,transport);closeMidiNotes(take,end);if(take.events.empty())continue;juce::var message=makeObject();setProp(message,"type","sequencerMidiRecorded");setProp(message,"trackId",juce::String(take.trackId));setProp(message,"startPpq",take.startPpq);setProp(message,"endPpq",std::max(take.startPpq+.001,end));juce::Array<juce::var> events;for(const auto&e:take.events){juce::var item=makeObject();setProp(item,"startPpq",e.startPpq);setProp(item,"durationPpq",e.durationPpq);setProp(item,"pitch",e.pitch);setProp(item,"velocity",e.velocity);setProp(item,"channel",e.channel);events.add(item);}setProp(message,"events",events);result.add(message);}
    for(auto& take:audioTakes_){take.writer->stop();if(!take.writer->hasTake())continue;juce::var message=makeObject();setProp(message,"type","sequencerAudioRecorded");setProp(message,"trackId",juce::String(take.trackId));setProp(message,"filePath",take.writer->takeFile().getFullPathName());setProp(message,"startPpq",take.startPpq);setProp(message,"durationSeconds",take.writer->duration());setProp(message,"bpm",take.bpm);setProp(message,"overrun",take.writer->overrun());result.add(message);}
    midiTakes_.clear();audioTakes_.clear();panic();return result;
}

void SequencerEngine::panic() noexcept
{
    needsChase_.store(true);midiCleanupPending_.store(true,std::memory_order_release);auto* plan=activePlan_.load(std::memory_order_acquire);if(!plan)return;for(auto& track:plan->tracks)if(track.destination)track.destination->panic();
}

void SequencerEngine::panicExport() noexcept
{
    needsExportChase_.store(true);exportMidiCleanupPending_.store(true,std::memory_order_release);auto* plan=exportPlan_.load(std::memory_order_acquire);if(!plan)return;for(auto& track:plan->tracks)if(track.destination)track.destination->panic();exportCleanupPending_.store(true,std::memory_order_release);
}

bool SequencerEngine::prepareExportPlan(
    const std::function<Chain*(const std::string&)>& chainLookup,
    std::string& error)
{
    if(exportTransactionActive_.load()||exportWriter_){error="An export is already active";return false;}
    auto* source=activePlan_.load(std::memory_order_acquire);
    if(!source){error="Sequencer arrangement is unavailable";return false;}
    auto next=std::make_unique<Plan>();next->generation=source->generation;next->tracks.reserve(source->tracks.size());
    for(const auto& original:source->tracks){Track track;track.id=original.id;track.type=original.type;track.inputId=original.inputId;track.outputId=original.outputId;track.armed=original.armed;track.midiOutputKind=original.midiOutputKind;track.midi=original.midi;track.audio=original.audio;track.clips=original.clips;track.runtime=std::make_shared<TrackRuntime>();if(original.runtime){track.runtime->gain.store(original.runtime->gain.load(std::memory_order_acquire),std::memory_order_relaxed);track.runtime->muted.store(original.runtime->muted.load(std::memory_order_acquire),std::memory_order_relaxed);}if(track.type=="audio"){track.audioSumScratch.setSize(2,std::max(blockSize_,4096),false,true,false);track.audioSumScratch.clear();}
        if(track.type=="midi"&&track.midiOutputKind==Track::MidiOutputKind::chain&&!track.outputId.empty()){track.destination=chainLookup(track.outputId);if(!track.destination){error="Export destination is unavailable: "+track.outputId;return false;}}
        if(track.type=="midi")track.midiScratch.ensureSize(std::max<size_t>(8192,track.midi.size()*24+256));next->tracks.push_back(std::move(track));}
    preparedExportPlan_=std::move(next);needsExportChase_.store(true);return true;
}

bool SequencerEngine::startExport(const juce::File& file,double start,double end,double tail,
                                  const Transport& liveTransport,const ExportOptions& options,
                                  juce::String& error)
{
    if(exportTransactionActive_.load()||exportWriter_){error="An export is already active";return false;}
    if(recording()){error="Stop recording before starting an export";return false;}
    if(!std::isfinite(start)||!std::isfinite(end)||!std::isfinite(tail)||start<0||end<=start||tail<0||tail>30){error="Export range is invalid";return false;}
    if(!preparedExportPlan_){error="Export arrangement snapshot is unavailable";return false;}
    auto raw=createExportWriter(file,sampleRate_,options,error);if(!raw)return false;
    exportWriter_=std::move(raw);
    exportFile_=file;exportFormat_=options.format.trim().toLowerCase();exportFrames_=0;
    exportTargetFrames_=(int64_t)std::ceil(((end-start)*60.0/liveTransport.bpm()+std::max(0.0,tail))*sampleRate_);
    exportEndPpq_=end;exportError_.clear();exportFinishPending_=false;exportCancelledPending_=false;exportSourceStopSent_=false;
    exportCancelRequested_.store(false,std::memory_order_release);
    offlineExportTransport_.setSampleRate(sampleRate_);offlineExportTransport_.setBpm(liveTransport.bpm());offlineExportTransport_.setRecording(false);offlineExportTransport_.setLoop(false,0,16);offlineExportTransport_.seekPpq(start);offlineExportTransport_.setPlaying(true);
    exportCleanupPending_.store(false,std::memory_order_release);exportMidiCleanupPending_.store(false,std::memory_order_release);exportPlan_.store(preparedExportPlan_.get(),std::memory_order_release);
    exportTransactionActive_.store(true,std::memory_order_release);exportActive_.store(true,std::memory_order_release);
    // Clones are newly created and chase from the requested range. Live held
    // notes and their future Note Offs remain untouched throughout the bounce.
    needsExportChase_.store(true,std::memory_order_release);return true;
}

bool SequencerEngine::cancelExport(bool publishTerminalEvent)
{
    if (!exportTransactionActive_.load(std::memory_order_acquire)
        && !exportWriter_ && !exportFinishPending_.load(std::memory_order_acquire))
        return false;
    exportCancelRequested_.store(false, std::memory_order_release);
    exportActive_.store(false, std::memory_order_release);
    while (exportCallbacks_.load(std::memory_order_acquire) > 0)
        juce::Thread::yield();
    if (auto* mp3 = dynamic_cast<CancelableLameWriter*>(exportWriter_.get()))
        mp3->cancel();
    exportWriter_.reset();
    exportFile_.deleteFile();
    exportFrames_.store(0, std::memory_order_release);
    exportTargetFrames_.store(0, std::memory_order_release);
    exportError_.clear();
    panicExport();
    auto* frozen=exportPlan_.exchange(nullptr,std::memory_order_acq_rel);
    while(planHazard_.load(std::memory_order_acquire)==frozen)juce::Thread::yield();
    preparedExportPlan_.reset();
    offlineExportTransport_.setPlaying(false);
    exportCancelledPending_.store(publishTerminalEvent,std::memory_order_release);
    exportFinishPending_.store(publishTerminalEvent,std::memory_order_release);
    exportTransactionActive_.store(publishTerminalEvent,std::memory_order_release);
    return true;
}

bool SequencerEngine::requestCancelExport(bool publishTerminalEvent) noexcept
{
    if (!exportTransactionActive_.load(std::memory_order_acquire)
        && !exportActive_.load(std::memory_order_acquire))
        return false;
    exportCancelPublishTerminal_.store(publishTerminalEvent, std::memory_order_release);
    exportCancelRequested_.store(true, std::memory_order_release);
    exportActive_.store(false, std::memory_order_release);
    return true;
}

bool SequencerEngine::finalizeRequestedCancel() noexcept
{
    if (!exportCancelRequested_.exchange(false, std::memory_order_acq_rel))
        return false;
    return cancelExport(exportCancelPublishTerminal_.load(std::memory_order_acquire));
}

void SequencerEngine::processMaster(float* const* channels,int channelCount,int count,Transport& transport) noexcept
{
    // Enter the callback gate before reading exportWriter_. cancelExport()
    // closes exportActive_ and waits on this count before destroying it.
    exportCallbacks_.fetch_add(1,std::memory_order_acq_rel);if(!exportActive_.load(std::memory_order_acquire)||!exportWriter_){exportCallbacks_.fetch_sub(1,std::memory_order_release);return;}const int64_t remaining=exportTargetFrames_.load()-exportFrames_.load();const int writeCount=(int)std::min<int64_t>(count,std::max<int64_t>(0,remaining));if(writeCount>0){const float* stereo[2]={channelCount>0?channels[0]:nullptr,channelCount>1?channels[1]:(channelCount>0?channels[0]:nullptr)};if(!stereo[0]||!stereo[1]||!exportWriter_->writeFromFloatArrays(stereo,2,writeCount)){exportError_="Master export writer failed";exportActive_=false;exportFinishPending_=true;transport.setPlaying(false);panicExport();}else exportFrames_.fetch_add(writeCount);}if(exportFrames_.load()>=exportTargetFrames_.load()){exportActive_=false;exportFinishPending_=true;transport.setPlaying(false);panicExport();}exportCallbacks_.fetch_sub(1,std::memory_order_release);
}

juce::Array<juce::var> SequencerEngine::serviceEvents()
{
    juce::Array<juce::var> events;if(!exportFinishPending_.exchange(false))return events;if(exportCleanupPending_.load(std::memory_order_acquire)){exportFinishPending_.store(true,std::memory_order_release);return events;}while(exportCallbacks_.load(std::memory_order_acquire)>0)juce::Thread::yield();exportActive_=false;exportWriter_.reset();auto* frozen=exportPlan_.exchange(nullptr,std::memory_order_acq_rel);if(frozen)while(planHazard_.load(std::memory_order_acquire)==frozen)juce::Thread::yield();preparedExportPlan_.reset();offlineExportTransport_.setPlaying(false);const bool cancelled=exportCancelledPending_.exchange(false);if(!cancelled&&exportError_.isEmpty()&&exportFile_.getSize()<=0)exportError_="Encoder produced an empty file";if(exportError_.isNotEmpty())exportFile_.deleteFile();exportTransactionActive_.store(false,std::memory_order_release);juce::var message=makeObject();setProp(message,"type","sequencerExport");setProp(message,"state",cancelled?"cancelled":(exportError_.isEmpty()?"complete":"error"));setProp(message,"format",exportFormat_);setProp(message,"filePath",exportFile_.getFullPathName());setProp(message,"frames",exportFrames_.load());setProp(message,"sampleRate",sampleRate_);setProp(message,"channels",2);setProp(message,"message",exportError_);events.add(message);return events;
}

} // namespace mlh
